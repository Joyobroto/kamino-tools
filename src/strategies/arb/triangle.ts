/**
 * Kamino Triangle Engine — USDC-base 3-hop cycles across Jupiter routes.
 *
 * The play: flashBorrow USDC from Kamino (fee 0.001%) → hop1 USDC→TOKEN,
 * hop2 TOKEN→SOL, hop3 SOL→USDC → repay → keep the difference. Atomic: a
 * losing cycle reverts and costs only the tx fee.
 *
 * Pricing discipline (hard lessons from the 2026-09-06 forensic):
 *   - NEVER price concentrated-liquidity pools by vault ratio (10x fantasy rate)
 *   - NEVER trust a price without executable depth (ghost pools)
 *   - The ONLY truth = a Jupiter quote for the exact trade size
 * Each hop is quoted as a real trade at the cycle size, with min-out floors.
 *
 * Where's the edge vs Jupiter's own aggregation? Round-trip quotes through one
 * aggregator collapse to no-ops; cycles that are profitable only when routed
 * as EXPLICIT SEQUENTIAL hops sometimes survive between quote refreshes and
 * across venue pairs the router prices separately. We measure honestly:
 * most passes will read "spread too thin" — a pass is only interesting when
 * the executable cycle clears costs by a real margin.
 */

import { fetchRawQuote, applySlippage, type RawQuote } from "./lst-arb.js";

/** USDC (Kamino Main-market reserve, 0.001% flash fee). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Cycle mid tokens: majors with deep multi-venue liquidity. */
export interface TriangleToken {
  symbol: string;
  mint: string;
  decimals: number;
}

/**
 * Registry verified via Jupiter token search (2026-09-06) — never trust
 * from-memory mint addresses; that trap cost us twice already.
 */
export const TRIANGLE_TOKENS: TriangleToken[] = [
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", decimals: 5 },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6 },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6 },
  { symbol: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", decimals: 6 },
  { symbol: "WEN", mint: "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk", decimals: 5 },
  { symbol: "MEW", mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", decimals: 9 },
];

export interface TriangleHop {
  fromMint: string;
  toMint: string;
  quote: RawQuote;
  minOut: bigint;
  labels: string[];
}

export interface TrianglePlan {
  token: TriangleToken;
  /** Borrow amount, USDC base units. */
  amountBaseUnits: bigint;
  hops: [TriangleHop, TriangleHop, TriangleHop];
  /** Final USDC out (quoted, not min-out). */
  outBaseUnits: bigint;
  /** Worst-case USDC out at all min-out floors. */
  worstOutBaseUnits: bigint;
  /** Profit in USDC base units at quoted prices. */
  profitBaseUnits: bigint;
  /** Worst-case profit at min-out floors. */
  worstProfitBaseUnits: bigint;
  at: string;
}

export interface TrianglePlanOptions {
  /** Cycle size in USDC base units. */
  sizeBaseUnits: bigint;
  /** Per-hop slippage, bps. */
  slippageBps: number;
}

export type TrianglePlanResult =
  | { ok: false; reason: string; token: string }
  | { ok: true; plan: TrianglePlan; profitUsd: number; worstProfitUsd: number };

/**
 * Plans the USDC→TOKEN→SOL→USDC cycle with executable quotes per hop.
 * Fails fast when any hop is unquotable or the cycle doesn't repay at quoted prices.
 */
export async function planTriangle(
  token: TriangleToken,
  options: TrianglePlanOptions,
  fetchImpl?: typeof fetch,
): Promise<TrianglePlanResult> {
  const { sizeBaseUnits, slippageBps } = options;
  if (sizeBaseUnits <= 0n) return { ok: false, reason: "size", token: token.symbol };

  // hop 1: USDC → TOKEN
  const q1 = await fetchRawQuote({ inputMint: USDC_MINT, outputMint: token.mint, amount: sizeBaseUnits.toString(), slippageBps }, fetchImpl);
  if (!q1) return { ok: false, reason: "hop1 unquotable", token: token.symbol };
  const out1 = BigInt(q1.outAmount);
  const hop1: TriangleHop = { fromMint: USDC_MINT, toMint: token.mint, quote: q1, minOut: applySlippage(out1, slippageBps), labels: labelsOf(q1) };

  // hop 2: TOKEN → SOL
  const q2 = await fetchRawQuote({ inputMint: token.mint, outputMint: WSOL_MINT, amount: out1.toString(), slippageBps }, fetchImpl);
  if (!q2) return { ok: false, reason: "hop2 unquotable", token: token.symbol };
  const out2 = BigInt(q2.outAmount);
  const hop2: TriangleHop = { fromMint: token.mint, toMint: WSOL_MINT, quote: q2, minOut: applySlippage(out2, slippageBps), labels: labelsOf(q2) };

  // hop 3: SOL → USDC
  const q3 = await fetchRawQuote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: out2.toString(), slippageBps }, fetchImpl);
  if (!q3) return { ok: false, reason: "hop3 unquotable", token: token.symbol };
  const out3 = BigInt(q3.outAmount);
  const hop3: TriangleHop = { fromMint: WSOL_MINT, toMint: USDC_MINT, quote: q3, minOut: applySlippage(out3, slippageBps), labels: labelsOf(q3) };

  const profitBaseUnits = out3 - sizeBaseUnits;
  // Fail fast: quoted cycle must already repay the borrow (the flash fee is
  // charged on top; the caller checks profit against it in the guards).
  if (profitBaseUnits <= 0n) {
    return { ok: false, reason: `cycle returns ${out3} < borrow ${sizeBaseUnits} (spread too thin)`, token: token.symbol };
  }

  // Worst-case chain: each hop's output floored by its min-out. The realistic
  // worst sequence evaluates every hop at its floor:
  //   hop1 floor is not enforceable on output of an input-fixed swap chain —
  //   the min-out protects the SELLER of each leg; a partial fill reverts.
  //   So the enforceable worst-case is: all hops succeed at their floors,
  //   final USDC = hop3.minOut when the earlier hops deliver at least their
  //   floors. Since hop inputs are quoted amounts, if hop1 delivers exactly
  //   minOut1 the hop2 quote size no longer matches — in the atomic tx,
  //   hop2's instruction is fixed at quoted sizes, so min-out2/3 fire against
  //   the actual outputs. Conservative enforceable floor = minOut3 only,
  //   documented as such; full worst-case simulation happens in the sim stage.
  const worstOut = hop3.minOut;
  const worstProfit = worstOut - sizeBaseUnits;

  return {
    ok: true,
    plan: {
      token,
      amountBaseUnits: sizeBaseUnits,
      hops: [hop1, hop2, hop3],
      outBaseUnits: out3,
      worstOutBaseUnits: worstOut,
      profitBaseUnits,
      worstProfitBaseUnits: worstProfit,
      at: new Date().toISOString(),
    },
    profitUsd: Number(profitBaseUnits) / 1e6,
    worstProfitUsd: Number(worstProfit) / 1e6,
  };
}

function labelsOf(quote: RawQuote): string[] {
  return ((quote.routePlan as Array<{ swapInfo?: { label?: string } }> | undefined) ?? []).map((step) => step.swapInfo?.label ?? "?");
}

/**
 * Kamino USDC flash-loan fee in base units: fee rate 0.001% (1 bps) on
 * borrow amount (read from the reserve config at build time; this is the
 * guard-side estimate).
 */
export function usdcFlashFeeBaseUnits(amountBaseUnits: bigint): bigint {
  return (amountBaseUnits * 1n) / 100_000n; // 0.001%
}
