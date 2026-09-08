/**
 * Cross-venue constant-product arb — the viable complement to Jupiter-triangle.
 *
 * Insight over the triangle experiment (see data/triangle_probe*.jsonl): Jupiter
 * routes already arbitrate spread across venues internally, so with Jupiter the
 * cycle was ALWAYS negative and never scalable (bigger size = 6x more drag).
 *
 * The edge left on the table is a DIRECT vault-truth dislocation between two
 * constant-product venues we price ourselves — no Jupiter router in the middle
 * eating the spread:
 *
 *   borrow SOL (Kamino flash, 0.001%)
 *     → swap SOL→T @ venue P (cheap: low SOL-per-T vault ratio)
 *     → swap T→SOL @ venue Q (dear: high SOL-per-T vault ratio)
 *   repay SOL + fee
 *
 * For a constant-product pool the executable mid-price of an infinitesimal swap
 * equals the vault ratio reserves[quote]/reserves[token]. IMPORTANT: verified
 * empirically (2026-09-07) that meteora-damm-v1 does NOT satisfy this — its
 * vault ratios read $203-380 while the market executes at $105-107, so damm-v1
 * is treated as PHANTOM (its 904B layout was only ever verified on one pool).
 * The only venue currently PROVEN executable-by-vault-ratio is pumpswap. The
 * scan/planner therefore gate on a per-pool executable check before reporting.
 *
 * CLMM/Whirlpool are deliberately excluded: their vault ratio is NOT the
 * executable price (proven empirically, 10x fantasy rates).
 */

import type { RpcClient } from "./pools.js";
import {
  constantsProductVenues,
  WSOL_MINT,
  BSOL_PLACEHOLDER_SYMBOL,
  SOL_DECIMALS,
  type ConstantProductVenue,
} from "./crossvenue-venues.js";
import {
  decodePoolAccount,
  type DecodedPool,
} from "./venues.js";

/** Cost model constants — Kamino flash-loan fee is 0.001% of principal. */
export const FLASH_FEE_FRACTION = 0.00001;
export const TX_FEE_SOL = 0.000005; // base tx fee (5000 lamports)

export interface CrossVenuePair {
  /** The non-quote token (the token being dislocated). */
  token: string;
  tokenDecimals: number;
  /** Quote token — either SOL (v1) or USDC. */
  quote: string;
  quoteDecimals: number;
  /** A pool holding this token+quote at venue A. */
  venueA: string;
  poolA: string;
  vaultAToken: bigint;
  vaultAQuote: bigint;
  /** A pool holding this token+quote at venue B. */
  venueB: string;
  poolB: string;
  vaultBToken: bigint;
  vaultBQuote: bigint;
  /** Quote-per-token at each venue (vault ratio, UI units). */
  priceA: number;
  priceB: number;
  /** priceB / priceA — the gross arb edge (>1 means buy A, sell B). */
  grossRatio: number;
  /** Realized edge after executing the pair swap at a given SOL size (see planner). */
  solPriceUsd: number;
  detectedAt: string;
}

/**
 * Constant-product mid price = quote reserve / token reserve (quote-per-token).
 * Number of quote units received for 1 token unit, at the margin.
 */
export function vaultMidPrice(tokenAmount: bigint, quoteAmount: bigint, tokenDecimals: number, quoteDecimals: number): number {
  if (tokenAmount <= 0n || quoteAmount <= 0n) return Number.NaN;
  const tokenUi = Number(tokenAmount) / 10 ** tokenDecimals;
  const quoteUi = Number(quoteAmount) / 10 ** quoteDecimals;
  return quoteUi / tokenUi;
}

/** How a pair is oriented in a decoded pool: which vault is the token, which is quote. */
export interface PoolOrientation {
  token: string;
  tokenDecimals: number;
  quote: string;
  quoteDecimals: number;
  vaultToken: string;
  vaultQuote: string;
}

/** Walks every decoded pool and emits (token, quote) orientations for SOL/USDC pairs. */
export function orientPool(pool: DecodedPool, config: {
  tokenMint: string;
  tokenDecimals: number;
  quote: string;
  quoteDecimals: number;
}): PoolOrientation | null {
  // Only consider pools pairing the target token with the configured quote.
  const pair = [pool.mintA, pool.mintB].sort();
  const target = [config.tokenMint, config.quote].sort().join("|");
  if (pair.join("|") !== target) return null;
  const tokenSide = pool.mintA === config.tokenMint ? "A" : "B";
  return {
    token: config.tokenMint,
    tokenDecimals: config.tokenDecimals,
    quote: config.quote,
    quoteDecimals: config.quoteDecimals,
    vaultToken: tokenSide === "A" ? pool.vaultA : pool.vaultB,
    vaultQuote: tokenSide === "A" ? pool.vaultB : pool.vaultA,
  };
}

export const DEFAULT_CROSS_VENUE_QUOTES: Array<{ tokenMint: string; tokenDecimals: number; quote: string; quoteDecimals: number }> = [
  { tokenMint: WSOL_MINT, tokenDecimals: 9, quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", quoteDecimals: 6 }, // SOL/USDC
];

export interface CrossVenueScanOptions {
  /** Minimum |grossRatio - 1| over 10000 (in bps) to report. */
  minEdgeBps: number;
  /** Minimum SOL value on both quote vaults to trust the ratios. */
  minVaultUsd: number;
  /** Probes to check, aligned with DEFAULT_CROSS_VENUE_QUOTES or override. */
  solPriceUsd: number;
  pairs?: Array<{ tokenMint: string; tokenDecimals: number; quote: string; quoteDecimals: number }>;
  /** Symbol label for the token (for logs). */
  tokenLabel?: string;
}

export interface CrossVenueEvent {
  type: "scan" | "pair";
  at: string;
  pair?: CrossVenuePair;
  poolsSeen?: number;
  pairsEvaluated?: number;
  opportunities?: number;
}

/**
 * Fetches eligible pools for the constant-product venues and returns live
 * vault balances keyed by pool address. Exposed for the planner.
 */
export async function fetchConstantProductPools(
  rpc: RpcClient,
  venues: ConstantProductVenue[] = constantsProductVenues(),
): Promise<Array<{ venue: string; pool: DecodedPool }>> {
  const out: Array<{ venue: string; pool: DecodedPool }> = [];
  for (const venue of venues) {
    const addresses = await rpc.listProgramAccounts(venue.programId, [{ dataSize: venue.layout.poolAccountSize }]);
    const accounts = await rpc.getMultipleAccounts(addresses);
    for (let i = 0; i < addresses.length; i += 1) {
      const account = accounts[i];
      const base64 = account?.data?.[0];
      if (!base64) continue;
      const pool = decodePoolAccount(venue, addresses[i]!, Buffer.from(base64, "base64"));
      if (pool) out.push({ venue: venue.name, pool });
    }
  }
  return out;
}

export { BSOL_PLACEHOLDER_SYMBOL, SOL_DECIMALS };
