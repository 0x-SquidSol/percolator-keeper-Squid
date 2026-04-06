/**
 * Shared types for keeper services.
 *
 * Extracted from crank.ts so adl.ts can import MarketCrankState without
 * creating a circular dependency.
 *
 * PERC-8293 (T11): Two-phase ADL dispatch scaffolding added.
 * When anchor T5 (PERC-8270) ships, wire PrepareAdlArgs / PrepareAdlResult
 * into adl.ts scanMarket() — see the T5 hook comment there.
 */
import type { DiscoveredMarket } from "@percolatorct/sdk";

export interface MarketCrankState {
  market: DiscoveredMarket;
  lastCrankTime: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  isActive: boolean;
  missingDiscoveryCount: number;
  permanentlySkipped?: boolean;
  permanentlySkippedAt?: number;
  skipCount?: number;
  mainnetCA?: string;
  foreignOracleSkipped?: boolean;
  hyperpNoPriceSkipped?: boolean;
  dexPoolAddress?: string;
}

// =============================================================================
// T5 / PERC-8270: Two-phase ADL dispatch scaffolding
// These types are NOT yet used — they are ready for when anchor T5 merges.
// Update adl.ts scanMarket() to send a PrepareAdl instruction and decode
// the PrepareAdlResult PDA before dispatching ExecuteAdl.
// =============================================================================

/**
 * Arguments for the PrepareAdl on-chain instruction (T5 phase 1).
 *
 * Phase 1 reads oracle price and current slab state, then writes a
 * PrepareAdlResult PDA that phase 2 (ExecuteAdl) consumes atomically.
 * Sending both in the same transaction ensures a consistent price snapshot.
 */
export interface PrepareAdlArgs {
  /** Slab address of the market */
  slabAddress: string;
  /** Current oracle price in e6 format */
  oraclePriceE6: bigint;
  /** Slot at which the price was read */
  priceSlot: bigint;
}

/**
 * Result decoded from the PrepareAdlResult PDA after phase 1 succeeds.
 * Passed to ExecuteAdl in phase 2.
 */
export interface PrepareAdlResult {
  /** PDA address of the PrepareAdlResult account */
  resultPda: string;
  /** Validated oracle price committed in phase 1 */
  committedPriceE6: bigint;
  /** Excess PnL above max_pnl_cap as computed on-chain in phase 1 */
  excessPnl: bigint;
  /** Slot the prepare was committed at */
  commitSlot: bigint;
}

/**
 * Discriminator byte for the PrepareAdl instruction.
 * Placeholder — replace with actual tag once anchor T5 IDL is published.
 * @see PERC-8270
 */
export const IX_TAG_PREPARE_ADL = 0xff; // TODO: replace with real tag from T5 IDL
