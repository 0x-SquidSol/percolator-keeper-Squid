/**
 * Network helpers for mainnet/devnet detection.
 * The @percolator/shared networkValidation module handles FORCE_MAINNET guards;
 * this module provides a simple runtime check for keeper-specific logic.
 */

export function isMainnet(): boolean {
  return process.env.NETWORK === "mainnet";
}
