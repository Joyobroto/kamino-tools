/**
 * Constant-product venue subset for cross-venue arb.
 *
 * The triangle experiment proved concentrated-liquidity venues (raydium-clmm,
 * orca-whirlpool) must be EXCLUDED from vault-truth pricing: their vault ratio
 * is not the executable marginal price (10x fantasy rates). Only constant-
 * product venues give an executable vault ratio.
 *
 * verified venues that are constant-product:
 * - pumpswap (WOFI pool: vaultMint/vaultQuote ratio == marginal price)
 * - meteora-damm (SOL/USDC verified @ 23.9K SOL / 2.6M USDC)
 * - meteora-damm-v2 (ANB pool verified)
 */

import { VENUES, type Venue } from "./venues.js";

/** Venues whose vault ratio IS the executable marginal price. */
export const CONSTANT_PRODUCT_VENUES: Venue[] = [
  VENUES.find((v) => v.name === "pumpswap")!,
  VENUES.find((v) => v.name === "meteora-damm")!,
  VENUES.find((v) => v.name === "meteora-damm-v2")!,
];

export type ConstantProductVenue = Venue;

export function constantsProductVenues(): Venue[] {
  return CONSTANT_PRODUCT_VENUES;
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const BSOL_PLACEHOLDER_SYMBOL = "BSOL";
export const SOL_DECIMALS = 9;