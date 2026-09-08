/**
 * Cross-venue swap planner — the P&L model for the two-hop play.
 *
 * Given two constant-product pools holding (T, Q) with reserves (tA,qA) and
 * (tB,qB), we want the SOL amount S_in to borrow, swap SOL→T in pool A
 * (price direction chosen so the buy is cheap), then T→SOL in pool B. The
 * marginal gain ratio is qA/tA vs qB/tB; the actual realized gain is computed
 * with full swap math (no linearization), including both pools' fee rates.
 *
 * The planner is PURE (unit-testable). It returns the maximum-profit swap size
 * and its realized gain; negative or impact-erased results are filtered.
 */

/** Swap output for a constant-product pool (x*y=k with a fee applied on input). */
export function cpSwapOut(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: number,
  feeBpsDenom: number = 10_000,
): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  // input net of fee
  const amountInNet = amountIn - (amountIn * BigInt(feeBps)) / BigInt(feeBpsDenom);
  if (amountInNet <= 0n) return 0n;
  const numerator = amountInNet * reserveOut;
  const denominator = reserveIn + amountInNet;
  return numerator / denominator;
}

export interface CpPoolSide {
  /** Reserve of the token being bought/sold (UI units). */
  reserveTokenInUi: number;
  /** Reserve of the quote (SOL) (UI units). */
  reserveQuoteInUi: number;
  /** Token amount received when swapping 1 SOL in (UI) — buy effectiveness. */
  effectivePriceSolInToken: number;
  feeBps: number;
}

export interface CrossVenuePlan {
  /** Borrow SOL size (UI). */
  solIn: number;
  /** Token expected from pool A (UI). */
  tokenOut: number;
  /** SOL expected from pool B (UI). */
  solOut: number;
  /** Gross realized edge = solOut - solIn (UI SOL). */
  grossSol: number;
  /** Gross edge in USD. */
  grossUsd: number;
  /** Net edge after flash fee + tx fee (USD). */
  netUsd: number;
  /** solOut / solIn - 1 in bps. */
  edgeBps: number;
  /** Direction: symbol of the venue we buy from (cheap side). */
  buyVenue: string;
  sellVenue: string;
  /** Token symbol/holder for reference. */
  tokenLabel: string;
}

export interface CrossVenuePlannerOptions {
  /** SOL price in USD (for USD P&L). */
  solPriceUsd: number;
  /** Pool fee of each side (bps). */
  feeBpsA?: number;
  feeBpsB?: number;
  /** Flash loan fee fraction (e.g. 0.00001). */
  flashFeeFraction?: number;
  /** Base tx fee in SOL UI. */
  txFeeSol?: number;
  /** Candidate sizes to try (UI SOL); defaults to a sweep around 1% of depth. */
  candidateSols?: number[];
}

export const DEFAULT_CP_FEE_BPS = 30; // typical pools: 0.3% fee
export const DEFAULT_CP_PLANNER: CrossVenuePlannerOptions = {
  solPriceUsd: 0,
  feeBpsA: DEFAULT_CP_FEE_BPS,
  feeBpsB: DEFAULT_CP_FEE_BPS,
  flashFeeFraction: 0.00001,
  txFeeSol: 0.000005,
};

/**
 * Plans the best SOL→T in pool A, T→SOL in pool B size. Pure.
 *
 * The two legs share one (T, SOL) pair across venues. Direction: we want to buy
 * T where it's cheap (low SOL-per-T / high T-per-SOL effective price) and sell
 * where it's dear. If A has the better buy price we buy A sell B; else reverse.
 * The gross edge = realized solOut for candidate sizes; we return the best.
 */
export function planCrossVenue(
  poolA: { tokenReserve: bigint; quoteReserve: bigint; tokenDecimals: number; quoteDecimals: number; venue: string },
  poolB: { tokenReserve: bigint; quoteReserve: bigint; tokenDecimals: number; quoteDecimals: number; venue: string },
  options: CrossVenuePlannerOptions,
): CrossVenuePlan | null {
  const toUiSol = (quoteReserve: bigint, quoteDecimals: number) => Number(quoteReserve) / 10 ** quoteDecimals;
  const toUiToken = (tokenReserve: bigint, tokenDecimals: number) => Number(tokenReserve) / 10 ** tokenDecimals;

  const solA = toUiSol(poolA.quoteReserve, poolA.quoteDecimals);
  const tokenA = toUiToken(poolA.tokenReserve, poolA.tokenDecimals);
  const solB = toUiSol(poolB.quoteReserve, poolB.quoteDecimals);
  const tokenB = toUiToken(poolB.tokenReserve, poolB.tokenDecimals);
  if (!(solA > 0) || !(tokenA > 0) || !(solB > 0) || !(tokenB > 0)) return null;

  const feeA = options.feeBpsA ?? DEFAULT_CP_FEE_BPS;
  const feeB = options.feeBpsB ?? DEFAULT_CP_FEE_BPS;
  const flashFee = options.flashFeeFraction ?? 0.00001;
  const txFee = options.txFeeSol ?? 0.000005;

  // Determine which venue to buy in: the one where a SOL→T swap nets more T.
  const buyInA = effectiveTokenPerSol(tokenA, solA, feeA) >= effectiveTokenPerSol(tokenB, solB, feeB);
  const buyPool = buyInA ? poolA : poolB;
  const sellPool = buyInA ? poolB : poolA;
  const buyVenue = buyInA ? poolA.venue : poolB.venue;
  const sellVenue = buyInA ? poolB.venue : poolA.venue;

  const solInUi = toUiSol(buyPool.quoteReserve, buyPool.quoteDecimals);
  const tokenInUi = toUiToken(buyPool.tokenReserve, buyPool.tokenDecimals);
  const solSellUi = toUiSol(sellPool.quoteReserve, sellPool.quoteDecimals);
  const tokenSellUi = toUiToken(sellPool.tokenReserve, sellPool.tokenDecimals);

  const candidates = options.candidateSols?.length ? options.candidateSols : sweepCandidates(solInUi, solSellUi);

  let best: CrossVenuePlan | null = null;
  for (const S of candidates) {
    if (!(S > 0) || S > solInUi * 0.5) continue; // don't cross >50% of buy side depth
    const tokenOut = cpSwapOutRawUi(S, solInUi, tokenInUi, feeA);
    const solOut = cpSwapOutRawUi(tokenOut, tokenSellUi, solSellUi, feeB);
    const grossSol = solOut - S;
    const grossUsd = grossSol * options.solPriceUsd;
    const netUsd = grossUsd - S * options.solPriceUsd * flashFee - txFee * options.solPriceUsd;
    const candidate: CrossVenuePlan = {
      solIn: S,
      tokenOut,
      solOut,
      grossSol,
      grossUsd,
      netUsd,
      edgeBps: S > 0 ? (grossSol / S) * 10_000 : 0,
      buyVenue,
      sellVenue,
      tokenLabel: "",
    };
    if (!best || candidate.netUsd > best.netUsd) best = candidate;
    if (candidate.solIn >= S) break;
  }
  return best && best.netUsd > 0 ? best : null;
}

/** Effective T-per-SOL for a SOL→T swap at the margin (UI). */
function effectiveTokenPerSol(tokenUi: number, solUi: number, feeBps: number): number {
  if (!(tokenUi > 0) || !(solUi > 0)) return 0;
  return (tokenUi / solUi) * (1 - feeBps / 10_000);
}

/** Candidate SOL sizes: log sweep from $10 to 20% of buy side depth. */
function sweepCandidates(buyDepthSol: number, sellDepthSol: number): number[] {
  const min = Math.min(30 / 150, buyDepthSol * 0.001); // ~$0.2 at SOL=$150
  const max = Math.min(buyDepthSol * 0.2, sellDepthSol * 0.2);
  const steps = 12;
  const out: number[] = [];
  for (let i = 0; i < steps; i += 1) out.push(min * Math.pow(max / min, i / (steps - 1)));
  return out;
}

/** Raw cpSwapOut computed on UI reserves (simplifies planner math). */
function cpSwapOutRawUi(amountInUi: number, reserveInUi: number, reserveOutUi: number, feeBps: number): number {
  if (!(amountInUi > 0) || !(reserveInUi > 0) || !(reserveOutUi > 0)) return 0;
  const net = amountInUi * (1 - feeBps / 10_000);
  return (net * reserveOutUi) / (reserveInUi + net);
}