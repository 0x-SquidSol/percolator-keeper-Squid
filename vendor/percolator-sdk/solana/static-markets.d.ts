/**
 * Static market registry — bundled list of known Percolator slab addresses.
 *
 * This is the tier-3 fallback for `discoverMarkets()`: when both
 * `getProgramAccounts` (tier 1) and the REST API (tier 2) are unavailable,
 * the SDK falls back to this bundled list to bootstrap market discovery.
 *
 * The addresses are fetched on-chain via `getMarketsByAddress`
 * (`getMultipleAccounts`), so all data is still verified on-chain.  The static
 * list only provides the *address directory* — no cached market data is used.
 *
 * ## Maintenance
 *
 * Update this list when new markets are deployed or old ones are retired.
 * Run `scripts/update-static-markets.ts` to regenerate from a permissive RPC
 * or the REST API.
 *
 * @module
 */
import type { Network } from "../config/program-ids.js";
/**
 * A single entry in the static market registry.
 *
 * Only the slab address (base58) is required.  Optional metadata fields
 * (`symbol`, `name`) are provided for debugging/logging purposes only —
 * they are **not** used for on-chain data and may become stale.
 */
export interface StaticMarketEntry {
    /** Base58-encoded slab account address. */
    slabAddress: string;
    /** Optional human-readable symbol (e.g. "SOL-PERP"). */
    symbol?: string;
    /** Optional descriptive name. */
    name?: string;
}
/**
 * Get the bundled static market list for a given network.
 *
 * Returns the built-in list merged with any entries added via
 * {@link registerStaticMarkets}.  Duplicates (by `slabAddress`) are removed
 * automatically — user-registered entries take precedence.
 *
 * @param network - Target network (`"mainnet"` or `"devnet"`)
 * @returns Array of static market entries (may be empty if no markets are known)
 *
 * @example
 * ```ts
 * import { getStaticMarkets } from "@percolator/sdk";
 *
 * const markets = getStaticMarkets("mainnet");
 * console.log(`${markets.length} known mainnet slab addresses`);
 * ```
 */
export declare function getStaticMarkets(network: Network): StaticMarketEntry[];
/**
 * Register additional static market entries at runtime.
 *
 * Use this to inject known slab addresses before calling `discoverMarkets()`
 * so that tier-3 fallback has addresses to work with — especially useful
 * right after mainnet launch when the bundled list may be empty.
 *
 * Entries are deduplicated by `slabAddress` — calling this multiple times
 * with the same address is safe.
 *
 * @param network - Target network
 * @param entries - One or more static market entries to register
 *
 * @example
 * ```ts
 * import { registerStaticMarkets } from "@percolator/sdk";
 *
 * registerStaticMarkets("mainnet", [
 *   { slabAddress: "ABC123...", symbol: "SOL-PERP" },
 *   { slabAddress: "DEF456...", symbol: "ETH-PERP" },
 * ]);
 * ```
 */
export declare function registerStaticMarkets(network: Network, entries: StaticMarketEntry[]): void;
/**
 * Clear all user-registered static market entries for a network.
 *
 * Useful in tests or when resetting state.
 *
 * @param network - Target network to clear (omit to clear all networks)
 */
export declare function clearStaticMarkets(network?: Network): void;
