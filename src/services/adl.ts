/**
 * ADL Service — PERC-8276 (T11): Auto-Deleverage crank loop
 *
 * Scaffolded before anchor T8 (PERC-8273) is complete. The service is
 * feature-flagged via env var `ADL_ENABLED=true` so it can run alongside
 * the existing crank service without affecting production behaviour until
 * the on-chain instruction is live.
 *
 * Responsibilities:
 *  1. Per-market: fetch slab data, check `pnl_pos_tot > max_pnl_cap`
 *  2. When ADL is needed: rank all profitable positions by PnL%
 *  3. Call ExecuteAdl (tag 50) on the top-ranked position
 *  4. Repeat until pnl_pos_tot ≤ max_pnl_cap or no profitable positions remain
 *
 * Two-phase crank note (T5/PERC-8270):
 *  The on-chain two-phase split (prepare + execute) lives in the Rust program.
 *  From the keeper's perspective the call signature is unchanged — we send a
 *  single KeeperCrank transaction. When T5 lands and the IDL changes, only
 *  this file and crank.ts need updating.
 *
 * Dependency surface:
 *  - @percolator/sdk:  fetchSlab, parseEngine, parseConfig, parseAllAccounts,
 *                      encodeExecuteAdl, ACCOUNTS_EXECUTE_ADL, buildAccountMetas,
 *                      buildIx, derivePythPushOraclePDA
 *  - @percolator/shared: getConnection, loadKeypair, sendWithRetryKeeper,
 *                        createLogger, sendWarningAlert, sendCriticalAlert
 */

import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  fetchSlab,
  parseEngine,
  parseConfig,
  parseAllAccounts,
  encodeExecuteAdl,
  ACCOUNTS_EXECUTE_ADL,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  type DiscoveredMarket,
} from "@percolator/sdk";
import {
  getConnection,
  loadKeypair,
  sendWithRetryKeeper,
  createLogger,
  sendWarningAlert,
  sendCriticalAlert,
} from "@percolator/shared";
import type { MarketCrankState } from "./crank-types.js";

const logger = createLogger("keeper:adl");

// ─── tunables ──────────────────────────────────────────────────────────────

/**
 * How often to run the ADL scan loop in milliseconds.
 * Default 10 s — fast enough to clear excess PnL promptly; slow enough to
 * avoid hammering RPC on quiet markets.
 */
const ADL_INTERVAL_MS = Number(process.env.ADL_INTERVAL_MS ?? 10_000);

/**
 * Maximum number of ExecuteAdl transactions sent per market per ADL scan.
 * Guards against runaway loops if on-chain state is not updating between cycles.
 */
const ADL_MAX_TX_PER_SCAN = Number(process.env.ADL_MAX_TX_PER_SCAN ?? 10);

/**
 * Insurance fund balance threshold below which ADL kicks in.
 * Set to 0 to rely solely on pnl_pos_tot > max_pnl_cap.
 *
 * Per PERC-305 spec: ADL is triggered when pnl_pos_tot > max_pnl_cap,
 * which is itself a proxy for insurance fund stress.  This extra guard
 * allows ops to tune ADL sensitivity independently.
 *
 * Unit: raw lamports (bigint).  Default 0 = disabled.
 */
const ADL_INSURANCE_THRESHOLD = BigInt(
  process.env.ADL_INSURANCE_THRESHOLD_LAMPORTS ?? "0"
);

// ─── types ─────────────────────────────────────────────────────────────────

interface RankedPosition {
  idx: number;
  pnlPct: bigint;   // PnL as % of capital × 1_000_000 (fixed-point)
  pnlAbs: bigint;   // Absolute positive PnL (raw)
  capital: bigint;
}

interface AdlMarketState {
  lastScanTime: number;
  adlTxSent: number;
  consecutiveErrors: number;
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Returns true when ADL should run for this market given engine state. */
function isAdlNeeded(
  pnlPosTot: bigint,
  maxPnlCap: bigint,
  insuranceFundBalance: bigint
): boolean {
  if (maxPnlCap === 0n) return false; // ADL disabled on market (max_pnl_cap=0)

  const capExceeded = pnlPosTot > maxPnlCap;

  // Optional insurance fund gate (operator configurable)
  const insuranceDepleted =
    ADL_INSURANCE_THRESHOLD > 0n &&
    insuranceFundBalance < ADL_INSURANCE_THRESHOLD;

  return capExceeded || insuranceDepleted;
}

/**
 * Rank all profitable positions by PnL% (descending).
 * Uses capital as denominator; positions with zero capital are excluded.
 */
function rankProfitablePositions(
  data: Uint8Array,
  excess: bigint
): RankedPosition[] {
  const allAccounts = parseAllAccounts(data);
  const profitable: RankedPosition[] = [];

  for (const { idx, account } of allAccounts) {
    if (account.positionSize === 0n) continue;
    if (account.pnl <= 0n) continue;

    const capital = account.capital > 0n ? account.capital : 1n; // guard div-by-zero
    const pnlAbs = account.pnl;
    // pnlPct = pnl * 1_000_000 / capital  (fixed-point, 6 decimal places)
    const pnlPct = (pnlAbs * 1_000_000n) / capital;

    profitable.push({ idx, pnlPct, pnlAbs, capital });
  }

  // Sort descending by PnL%: highest earner deleveraged first.
  // Tie-break by absolute PnL descending.
  profitable.sort((a, b) => {
    if (b.pnlPct !== a.pnlPct) return b.pnlPct > a.pnlPct ? 1 : -1;
    return b.pnlAbs > a.pnlAbs ? 1 : -1;
  });

  return profitable;
}

// ─── ADL service class ─────────────────────────────────────────────────────

export class AdlService {
  private markets = new Map<string, AdlMarketState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _getMarkets: (() => Map<string, MarketCrankState>) | null = null;
  private _isRunning = false;
  private _cycling = false;

  /** Inject the crank service's market map so ADL can iterate tracked markets. */
  setMarketSource(fn: () => Map<string, MarketCrankState>): void {
    this._getMarkets = fn;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Scan one market for ADL conditions.
   * Returns number of ExecuteAdl transactions sent (0 if ADL not needed).
   */
  async scanMarket(slabAddress: string, market: DiscoveredMarket): Promise<number> {
    const connection = getConnection();
    const keypair = loadKeypair(process.env.CRANK_KEYPAIR!);
    const programId = market.programId;

    let data: Uint8Array;
    try {
      data = await fetchSlab(connection, market.slabAddress);
    } catch (err) {
      logger.warn("ADL: fetchSlab failed", {
        slabAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    const engine = parseEngine(data);
    const config = parseConfig(data);

    const pnlPosTot = engine.pnlPosTot;
    const maxPnlCap = config.maxPnlCap;
    const insuranceFundBalance = engine.insuranceFund.balance;

    if (!isAdlNeeded(pnlPosTot, maxPnlCap, insuranceFundBalance)) {
      return 0;
    }

    const excess = pnlPosTot - maxPnlCap;
    logger.info("ADL triggered for market", {
      slabAddress,
      pnlPosTot: pnlPosTot.toString(),
      maxPnlCap: maxPnlCap.toString(),
      excess: excess.toString(),
      insuranceFundBalance: insuranceFundBalance.toString(),
    });

    // Rank profitable positions
    const ranked = rankProfitablePositions(data, excess);
    if (ranked.length === 0) {
      logger.warn("ADL: pnl_pos_tot exceeds cap but no profitable positions found — stale state?", {
        slabAddress,
      });
      return 0;
    }

    // Determine oracle key (same logic as crank.ts)
    const feedBytes = config.indexFeedId.toBytes();
    const isZeroFeed = feedBytes.every((b: number) => b === 0);
    const isAdminOracle = !config.oracleAuthority.equals(PublicKey.default);

    let oracleKey: PublicKey;
    if (isAdminOracle || isZeroFeed) {
      // Admin-oracle or HYPERP mode: oracle account is the slab itself
      oracleKey = market.slabAddress;
    } else {
      const feedHex = Array.from(feedBytes)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");
      oracleKey = derivePythPushOraclePDA(feedHex)[0];
    }

    let sent = 0;
    let remainingExcess = excess;

    for (const pos of ranked) {
      if (sent >= ADL_MAX_TX_PER_SCAN) {
        logger.warn("ADL: reached max tx cap per scan", {
          slabAddress,
          maxTxPerScan: ADL_MAX_TX_PER_SCAN,
          remainingExcess: remainingExcess.toString(),
        });
        break;
      }
      if (remainingExcess <= 0n) break;

      try {
        const adlData = encodeExecuteAdl({ targetIdx: pos.idx });
        const adlKeys = buildAccountMetas(ACCOUNTS_EXECUTE_ADL, [
          keypair.publicKey,
          market.slabAddress,
          SYSVAR_CLOCK_PUBKEY,
          oracleKey,
        ]);
        const ix = buildIx({ programId, keys: adlKeys, data: adlData });

        const sig = await sendWithRetryKeeper(connection, [ix], [keypair]);

        logger.info("ADL tx sent", {
          slabAddress,
          targetIdx: pos.idx,
          pnlPct: (Number(pos.pnlPct) / 1_000_000).toFixed(4) + "%",
          sig,
        });

        sent++;
        // Optimistic: reduce remaining excess by the position's PnL.
        // On next cycle we re-fetch fresh state anyway.
        remainingExcess =
          remainingExcess > pos.pnlAbs ? remainingExcess - pos.pnlAbs : 0n;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("ADL tx failed", {
          slabAddress,
          targetIdx: pos.idx,
          error: errMsg,
        });

        const state = this._getOrCreateState(slabAddress);
        state.consecutiveErrors++;

        if (state.consecutiveErrors >= 3) {
          await sendWarningAlert("ADL consecutive failures", [
            { name: "Market", value: slabAddress.slice(0, 12), inline: true },
            {
              name: "Consecutive Errors",
              value: state.consecutiveErrors.toString(),
              inline: true,
            },
            { name: "Error", value: errMsg.slice(0, 100), inline: false },
          ]).catch(() => {});
        }
        // Continue to next position — one failure shouldn't abort the whole run.
      }
    }

    if (sent > 0) {
      const state = this._getOrCreateState(slabAddress);
      state.adlTxSent += sent;
      state.consecutiveErrors = 0;
    }

    return sent;
  }

  /** Run ADL scan across all tracked markets. */
  async scanAll(): Promise<{ scanned: number; triggered: number; txSent: number }> {
    if (!this._getMarkets) return { scanned: 0, triggered: 0, txSent: 0 };

    const markets = this._getMarkets();
    let scanned = 0;
    let triggered = 0;
    let txSent = 0;

    for (const [slabAddress, crankState] of markets) {
      // Skip permanently-skipped markets
      if ((crankState as any).permanentlySkipped) continue;
      if ((crankState as any).foreignOracleSkipped) continue;

      try {
        const sent = await this.scanMarket(slabAddress, crankState.market);
        scanned++;
        if (sent > 0) {
          triggered++;
          txSent += sent;
        }
      } catch (err) {
        logger.error("ADL scanMarket threw unexpectedly", {
          slabAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scanned, triggered, txSent };
  }

  start(getMarkets: () => Map<string, MarketCrankState>): void {
    if (this.timer) return;
    this._getMarkets = getMarkets;
    this._isRunning = true;

    logger.info("ADL service starting", { intervalMs: ADL_INTERVAL_MS });

    this.timer = setInterval(async () => {
      if (this._cycling) return;
      this._cycling = true;
      try {
        const result = await this.scanAll();
        if (result.triggered > 0) {
          logger.info("ADL scan complete", result);
        }
      } catch (err) {
        logger.error("ADL scan cycle error", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this._cycling = false;
      }
    }, ADL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._isRunning = false;
      logger.info("ADL service stopped");
    }
  }

  private _getOrCreateState(slabAddress: string): AdlMarketState {
    if (!this.markets.has(slabAddress)) {
      this.markets.set(slabAddress, {
        lastScanTime: 0,
        adlTxSent: 0,
        consecutiveErrors: 0,
      });
    }
    return this.markets.get(slabAddress)!;
  }

  getStats(): Map<string, AdlMarketState> {
    return this.markets;
  }
}
