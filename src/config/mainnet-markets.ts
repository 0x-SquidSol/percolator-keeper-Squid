/**
 * Well-known mainnet HYPERP market collateral mints.
 * These are informational/validation constants — the oracle already handles
 * mainnet mints correctly via DexScreener/Jupiter lookups.
 */
export const MAINNET_HYPERP_MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  BTC: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // WBTC
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // WETH
} as const;

export type MainnetHyperpAsset = keyof typeof MAINNET_HYPERP_MINTS;
