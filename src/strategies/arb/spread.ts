import { MINT_DECIMALS, type MintSymbol, type NormalizedQuote, type RoundTripResult } from "./types.js";

const BPS_SCALE = 10_000;

/**
 * Spread of a completed round trip in bps, computed on raw base units so the
 * round-trip cancels decimals. Positive = profitable before fixed costs.
 */
export function roundTripSpreadBps(inAmount: bigint, outAmount: bigint): number {
  if (inAmount <= 0n) return Number.NEGATIVE_INFINITY;
  return Number((outAmount * BigInt(BPS_SCALE)) / inAmount - BigInt(BPS_SCALE));
}

/** Absolute profit in base-mint base units for a round trip. */
export function roundTripProfitBaseUnits(inAmount: bigint, outAmount: bigint): bigint {
  return outAmount - inAmount;
}

/**
 * Approximate USD value of a profit expressed in base-mint base units.
 * For stable bases we assume 1:1; for SOL bases we pass the USDC-per-SOL
 * price derived from the same quotes (so no extra oracle dependency).
 */
export function profitUsdApprox(base: MintSymbol, profitBaseUnits: bigint, solPriceUsd?: number): number {
  const decimals = MINT_DECIMALS[base];
  const units = Number(profitBaseUnits) / 10 ** decimals;
  if (base === "WSOL" || base === "JitoSOL" || base === "JupSOL") {
    const price = solPriceUsd ?? 0;
    return units * price;
  }
  return units;
}

/**
 * Combines two normalized quotes into a round-trip result. Returns null when
 * the pair is not a valid round trip (mismatched mints) or inputs are unusable.
 */
export function buildRoundTrip(
  base: MintSymbol,
  intermediate: MintSymbol,
  sizeUsd: number,
  legOut: NormalizedQuote,
  legBack: NormalizedQuote,
  solPriceUsd?: number,
): RoundTripResult | null {
  if (legOut.outputMint !== legBack.inputMint) return null;
  if (legBack.outputMint !== legOut.inputMint) return null;
  if (legOut.inAmount <= 0n) return null;

  const spreadBps = roundTripSpreadBps(legOut.inAmount, legBack.outAmount);
  const profitUnits = roundTripProfitBaseUnits(legOut.inAmount, legBack.outAmount);
  const priceImpactMaxPct = Math.max(legOut.priceImpactPct, legBack.priceImpactPct);
  const routeLabels = [...legOut.routeLabels, ...legBack.routeLabels];

  return {
    base,
    intermediate,
    sizeUsd,
    spreadBps,
    profitBaseUnits: profitUnits.toString(),
    profitUsdApprox: profitUsdApprox(base, profitUnits, solPriceUsd),
    priceImpactMaxPct,
    routeLabels,
    fetchedAt: legBack.fetchedAt,
  };
}

/**
 * Execution gate: is this opportunity worth attempting?
 * Fixed cost model: base tx fee + priority fee estimate, both in USD.
 */
export function isActionable(result: RoundTripResult, fixedCostUsd: number, profitFloorUsd: number): boolean {
  if (result.spreadBps <= 0) return false;
  if (result.priceImpactMaxPct > 1) return false;
  const net = result.profitUsdApprox - fixedCostUsd;
  return net >= profitFloorUsd;
}

/** Fee model: base fee (5000 lamports) + configurable priority fee, in USD. */
export function estimateFixedCostUsd(priorityFeeLamports: number, solPriceUsd: number): number {
  const totalLamports = 5_000 + priorityFeeLamports;
  return (totalLamports / 1e9) * solPriceUsd;
}

/** Sort opportunities by approximate net profit (descending). */
export function rankByProfit(results: RoundTripResult[], fixedCostUsd: number): RoundTripResult[] {
  return results
    .slice()
    .sort((a, b) => (b.profitUsdApprox - fixedCostUsd) - (a.profitUsdApprox - fixedCostUsd));
}
