import type { KaminoObligation } from "@kamino-finance/klend-sdk";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import type { LiquidatableCandidate, ScanOptions } from "./types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SF_SCALE = 1e18;

export interface MarketReserveInfo {
  symbol: string;
  liquidityMint: string;
  flashLoanEnabled: boolean;
  flashLoanFeeRate: number;
  liquidationBonus: number;
  liquidationBonusMax: number;
  badDebtLiquidationBonus?: number;
  availableUsd: number;
  priceValid: boolean;
  /** The liquidation threshold (% of value) — drives the program's pair-priority. */
  liquidationThresholdPct: number;
  protocolLiquidationFeePct?: number;
  borrowFactorPct?: number;
  loanToValuePct?: number;
}

/** Market-level knobs that ride ON the reserve map (key `__market__`) so every
 * rail prices the prize with the program's real rules without threading a param
 * through all callers. Live mainnet values (probed 2026-09-24):
 * close factor 10%, insolvency LTV 95%, dust threshold $2, max-at-once $2,500,000. */
export interface MarketLevelInfo {
  /** `LendingMarket.liquidationMaxDebtCloseFactorPct`. */
  __marketCloseFactorPct?: number;
  /** `LendingMarket.insolvencyRiskUnhealthyLtvPct` — LTV above this raises the
   * close factor to 100%. */
  __marketInsolvencyLtvPct?: number;
  /** `LendingMarket.minFullLiquidationValueThreshold`, raw USD — borrows below
   * it must be repaid in full; the program bypasses the close factor. */
  __marketFullLiqThresholdUsd?: number;
  /** `LendingMarket.maxLiquidatableDebtMarketValueAtOnce`, raw USD. */
  __marketMaxAtOnceUsd?: number;
}

export type MarketReserveMap = Map<string, MarketReserveInfo & Partial<MarketLevelInfo>>;

export function isVanillaObligation(obligation: KaminoObligation): boolean {
  return obligation.obligationTag === ObligationTypeTag.Vanilla;
}

export function sfToUsd(value: bigint | number): number {
  return Number(BigInt(value)) / SF_SCALE;
}

export function wsolAwareSymbol(reserveAddress: string, marketReserves: MarketReserveMap): string {
  const reserve = marketReserves.get(reserveAddress);
  if (!reserve) return reserveAddress.slice(0, 4);
  if (reserve.liquidityMint === WSOL_MINT) return "WSOL";
  return reserve.symbol;
}

export function healthFactorFromSf(debtSf: bigint, unhealthySf: bigint): number {
  if (debtSf <= 0n) return Number.POSITIVE_INFINITY;
  return Number(unhealthySf) / Number(debtSf);
}

/** Kamino's reserve bonus grows with the depth of the LTV breach, then is
 * capped by max bonus and solvency. For an ordinary position the health factor
 * lets us approximate current LTV as liquidation threshold / health. */
export function dynamicLiquidationBonus(input: {
  healthFactor: number;
  liquidationThresholdPct: number;
  minBonus: number;
  maxBonus: number;
  badDebtBonus?: number;
}): number {
  const thresholdBps = Math.max(0, Math.min(10_000, input.liquidationThresholdPct * 100));
  const health = Number.isFinite(input.healthFactor) && input.healthFactor > 0 ? input.healthFactor : 0;
  const currentLtvBps = Math.min(10_000, health > 0 ? thresholdBps / health : 10_000);
  const minBps = Math.max(0, input.minBonus * 10_000);
  const maxBps = Math.max(minBps, input.maxBonus * 10_000);
  const breachBonusBps = Math.max(minBps, currentLtvBps - thresholdBps);
  const solvencyCapBps = Math.max(0, 10_000 - currentLtvBps);
  const bonusBps = Math.min(breachBonusBps, maxBps, solvencyCapBps);
  if (currentLtvBps >= 9_900 && input.badDebtBonus !== undefined) {
    // Bad-debt band (`user_no_bf_ltv >= 0.99`): the program returns
    // `max(from_bps(bad_debt_bonus), 1 - user_no_bf_ltv)` — the solvency term is a
    // FLOOR here, not a cap. The position is already insolvent, so the protocol
    // still pays the bad-debt bonus instead of shrinking it toward zero.
    const solvencyFloorBps = Math.max(0, 10_000 - currentLtvBps);
    return Math.max(Math.max(0, input.badDebtBonus) * 10_000, solvencyFloorBps) / 10_000;
  }
  return Math.max(0, bonusBps) / 10_000;
}

/**
 * The program's repay cap, in USD — `max_liquidatable_borrowed_amount`
 * (programs/klend/src/state/liquidation_operations.rs, `LtvExceeded`):
 *
 *     calculated = total_obligation_debt_mv × close_factor_rate
 *     cap        = min(calculated,
 *                      obligation_debt_for_liquidity_mv,
 *                      market.get_max_liquidatable_debt_market_value_at_once())
 *
 * The close factor is charged on the obligation's TOTAL debt, not on the single
 * borrow being repaid. On a one-borrow obligation that collapses to
 * `borrow × cf` — which is what this bot used to compute everywhere — but on a
 * multi-borrow obligation the program lets us repay up to `total × cf` of ANY one
 * borrow. Sizing `borrow × cf` forfeits most of that quota on exactly the
 * positions where the correctly-sized prize would otherwise clear the floor.
 *
 * Below `min_full_liquidation_value_threshold` (live: $2) the program BYPASSES
 * the close factor and takes the whole `borrowed_amount`, so the cap is 100% of
 * the borrow — the same band `chooseRepayBaseUnits` enforces on the way to chain.
 *
 * The `max_at_once` term is included for fidelity with the program. It is $2.5M
 * on this market, so it does not bind in our debt band; leaving it out would only
 * have over-estimated prize on sizes we never attempt.
 */
export function maxRepayUsd(input: {
  /** The single borrow we intend to repay, USD. */
  borrowValueUsd: number;
  /** Sum of ALL the obligation's borrows, USD. Defaults to the borrow itself. */
  totalDebtUsd?: number;
  closeFactorPct?: number;
  fullLiquidationThresholdUsd?: number;
  maxAtOnceUsd?: number;
}): number {
  const finite = (v: number | undefined): number | undefined =>
    v !== undefined && Number.isFinite(v) ? v : undefined;
  const borrow = Math.max(0, finite(input.borrowValueUsd) ?? 0);
  if (borrow <= 0) return 0;
  const threshold = Math.max(0, finite(input.fullLiquidationThresholdUsd) ?? 0);
  if (threshold > 0 && borrow < threshold) return borrow; // dust → full liquidation
  const closeFactor = Math.max(0, Math.min(100, finite(input.closeFactorPct) ?? 100)) / 100;
  const total = Math.max(borrow, finite(input.totalDebtUsd) ?? borrow);
  // A zero cap means "unset", never "repay nothing".
  const atOnceRaw = finite(input.maxAtOnceUsd) ?? Number.POSITIVE_INFINITY;
  return Math.min(total * closeFactor, borrow, atOnceRaw > 0 ? atOnceRaw : Number.POSITIVE_INFINITY);
}

/**
 * The close factor the program will apply to THIS obligation.
 *
 * `calculate_liquidation` normally uses `market.get_liquidation_max_debt_close_factor()`
 * but raises it to `Fraction::ONE` (100%) while
 * `obligation.loan_to_value() > market.get_insolvency_risk_unhealthy_ltv()`
 * (live: 95%). Without that branch every deeply-underwater position — the ones
 * with the biggest real prize — is under-priced by up to 10×.
 */
export function effectiveCloseFactorPct(obligation: KaminoObligation, marketReserves: MarketReserveMap): number {
  const meta = marketReserves.get("__market__");
  const nominal = meta?.__marketCloseFactorPct ?? 100;
  const insolvencyLtvPct = meta?.__marketInsolvencyLtvPct;
  if (insolvencyLtvPct === undefined) return nominal;
  // The field is a u8 percent describing a NEAR-SOLVENCY boundary. Anything
  // outside 50–100% cannot be an insolvency LTV for a market whose max borrow LTV
  // sits around 70–90%, so ignore it rather than risk a 10× over-estimate.
  if (insolvencyLtvPct < 50 || insolvencyLtvPct > 100) return nominal;
  if (typeof obligation.loanToValue !== "function") return nominal;
  let ltv: number;
  try {
    ltv = obligation.loanToValue().toNumber();
  } catch {
    return nominal;
  }
  if (!Number.isFinite(ltv)) return nominal;
  return ltv > insolvencyLtvPct / 100 ? 100 : nominal;
}

/** The market-level caps `maxRepayUsd` needs for this obligation, read off the map. */
function repayCaps(obligation: KaminoObligation, marketReserves: MarketReserveMap): {
  closeFactorPct: number;
  fullLiquidationThresholdUsd?: number;
  maxAtOnceUsd?: number;
} {
  const meta = marketReserves.get("__market__");
  return {
    closeFactorPct: effectiveCloseFactorPct(obligation, marketReserves),
    ...(meta?.__marketFullLiqThresholdUsd !== undefined
      ? { fullLiquidationThresholdUsd: meta.__marketFullLiqThresholdUsd }
      : {}),
    ...(meta?.__marketMaxAtOnceUsd !== undefined ? { maxAtOnceUsd: meta.__marketMaxAtOnceUsd } : {}),
  };
}

/**
 * Bonus bounds as `calculate_liquidation_bonus` derives them from the two chosen
 * reserves:
 *
 *   max_bonus_bps          = max(collateral.max, debt.max)
 *   min_reserve_bonus_bps  = max(collateral.min, debt.min)
 *   bad_debt_bonus_bps     = min(collateral.bad_debt, debt.bad_debt)
 *
 * Reading only the collateral side (what we did) under-quotes the prize whenever
 * the debt reserve carries the wider band — e.g. a 1%-min collateral paired with
 * a 5%-min debt reserve. Note the bad-debt term is the odd one out: `min`, not `max`.
 */
function bonusBounds(seized: MarketReserveInfo | undefined, debt: MarketReserveInfo | undefined): {
  minBonus: number;
  maxBonus: number;
  badDebtBonus?: number;
} {
  const badDebtBonus =
    seized?.badDebtLiquidationBonus !== undefined || debt?.badDebtLiquidationBonus !== undefined
      ? Math.min(seized?.badDebtLiquidationBonus ?? Number.POSITIVE_INFINITY, debt?.badDebtLiquidationBonus ?? Number.POSITIVE_INFINITY)
      : undefined;
  return {
    minBonus: Math.max(seized?.liquidationBonus ?? 0, debt?.liquidationBonus ?? 0),
    maxBonus: Math.max(seized?.liquidationBonusMax ?? 0, debt?.liquidationBonusMax ?? 0),
    ...(badDebtBonus !== undefined ? { badDebtBonus } : {}),
  };
}

/** Estimated margin after protocol share and flash fee, BEFORE swap/network costs.
 * Repay sizing is `maxRepayUsd` — the program's own cap — so this tracks what a
 * correctly-sized attempt would earn. This is screening metadata, not a quote or
 * realized profit. */
export function estimateLiquidationProfit(input: {
  debtUsd: number;
  totalDebtUsd?: number;
  liquidationBonus: number;
  closeFactorPct?: number;
  flashLoanFeeRate?: number;
  protocolLiquidationFeePct?: number;
  fullLiquidationThresholdUsd?: number;
  maxAtOnceUsd?: number;
}): number {
  const bonus = Math.max(0, input.liquidationBonus);
  // Default 100 / no dust band only when the caller has no market state (unit tests).
  const repayUsd = maxRepayUsd({
    borrowValueUsd: input.debtUsd,
    ...(input.totalDebtUsd !== undefined ? { totalDebtUsd: input.totalDebtUsd } : {}),
    ...(input.closeFactorPct !== undefined ? { closeFactorPct: input.closeFactorPct } : {}),
    ...(input.fullLiquidationThresholdUsd !== undefined
      ? { fullLiquidationThresholdUsd: input.fullLiquidationThresholdUsd }
      : {}),
    ...(input.maxAtOnceUsd !== undefined ? { maxAtOnceUsd: input.maxAtOnceUsd } : {}),
  });
  const feeRate = Math.max(0, input.flashLoanFeeRate ?? 0);
  return repayUsd * (bonus * (1 - (input.protocolLiquidationFeePct ?? 0) / 100) - feeRate);
}

function largestDebtPosition(
  obligation: KaminoObligation,
  marketReserves: MarketReserveMap,
): LiquidatableCandidate["largestDebt"] {
  let best: LiquidatableCandidate["largestDebt"] | null = null;
  for (const borrow of obligation.getBorrows()) {
    const info = marketReserves.get(borrow.reserveAddress);
    const symbol = info ? (info.liquidityMint === WSOL_MINT ? "WSOL" : info.symbol) : borrow.reserveAddress.slice(0, 4);
    const amountUsd = Number(borrow.marketValueRefreshed.toFixed(4));
    if (!best || amountUsd > best.amountUsd) {
      best = { reserve: borrow.reserveAddress, symbol, amountUsd };
    }
  }
  if (!best) throw new Error("Obligation has no borrows");
  return best;
}

export function obligationToCandidate(
  obligation: KaminoObligation,
  marketReserves: MarketReserveMap,
): LiquidatableCandidate {
  const stats = obligation.refreshedStats;
  const largestDebt = largestDebtPosition(obligation, marketReserves);
  // Prize estimate is set HERE (not only in filterLiquidatable) so every rail —
  // WS onSlice, hot tick, executeDue's own hydration — carries the same estimate.
  // Without it the --min-prize firewall saw prizeUsd = 0 and silently killed
  // every event-driven fire.
  const priorityBorrow = obligation.getBorrows().filter((b) => b.marketValueRefreshed.gt(0) && marketReserves.has(b.reserveAddress))
    .sort((a, b) => (marketReserves.get(b.reserveAddress)?.borrowFactorPct ?? 100)
      - (marketReserves.get(a.reserveAddress)?.borrowFactorPct ?? 100))[0];
  const repayDebt = priorityBorrow ? {
    reserve: priorityBorrow.reserveAddress,
    symbol: wsolAwareSymbol(priorityBorrow.reserveAddress, marketReserves),
    amountUsd: priorityBorrow.marketValueRefreshed.toNumber(),
  } : largestDebt;
  const debtReserveInfo = marketReserves.get(repayDebt.reserve);
  const caps = repayCaps(obligation, marketReserves);
  const totalDebtUsd = Number(stats.userTotalBorrow.toFixed(4));
  // The liquidation bonus is paid in extra COLLATERAL — it comes from the
  // withdraw reserve's config (docs + program layout), not the debt side.
  // At screening time the pair isn't chosen yet: use the program's own priority
  // (lowest liquidation-threshold deposit is seized first) so the estimate matches
  // what the executor will actually pick.
  const seizedCollateral = obligation.getDeposits()
    .map((deposit) => ({ deposit, info: marketReserves.get(deposit.reserveAddress) }))
    .filter((entry): entry is { deposit: (typeof entry)["deposit"]; info: NonNullable<(typeof entry)["info"]> } => Boolean(entry.info && entry.info.availableUsd > 0 && (entry.info.loanToValuePct ?? 1) > 0))
    .sort((a, b) => a.info.liquidationThresholdPct - b.info.liquidationThresholdPct)[0];
  const bonus = seizedCollateral
    ? dynamicLiquidationBonus({
      healthFactor: healthFactor(obligation),
      liquidationThresholdPct: seizedCollateral.info.liquidationThresholdPct,
      ...bonusBounds(seizedCollateral.info, debtReserveInfo),
    })
    : 0;
  const estimatedRepayUsd = maxRepayUsd({
    borrowValueUsd: repayDebt.amountUsd,
    totalDebtUsd,
    ...caps,
  });
  const estimatedProfitUsd = estimateLiquidationProfit({
    debtUsd: repayDebt.amountUsd,
    totalDebtUsd,
    liquidationBonus: bonus,
    protocolLiquidationFeePct: seizedCollateral?.info.protocolLiquidationFeePct ?? 0,
    ...caps,
    ...(debtReserveInfo?.flashLoanFeeRate ? { flashLoanFeeRate: debtReserveInfo.flashLoanFeeRate } : {}),
  });
  return {
    obligation: obligation.obligationAddress,
    tag: obligation.obligationTag,
    healthFactor: healthFactor(obligation),
    depositedValueUsd: Number(stats.userTotalDeposit.toFixed(4)),
    borrowedValueUsd: Number(stats.userTotalBorrow.toFixed(4)),
    largestDebt,
    repayDebt,
    estimatedRepayUsd,
    collateralSymbols: obligation.getDeposits().map((deposit) => {
      const info = marketReserves.get(deposit.reserveAddress);
      if (!info) return deposit.reserveAddress.slice(0, 4);
      return info.liquidityMint === WSOL_MINT ? "WSOL" : info.symbol;
    }),
    estimatedProfitUsd,
  };
}

export function healthFactor(obligation: KaminoObligation): number {
  const stats = obligation.refreshedStats;
  const borrowed = stats.userTotalBorrowBorrowFactorAdjusted;
  const liquidationLimit = stats.borrowLiquidationLimit;
  if (borrowed.lte(0)) return Number.POSITIVE_INFINITY;
  return liquidationLimit.div(borrowed).toNumber();
}

export interface FunnelSkipReason {
  nonVanilla: number;
  healthy: number;
  outOfBand: number;
  noFlashDebt: number;
  staleOracle: number;
  belowFloor: number;
}

export function filterLiquidatable(
  obligations: KaminoObligation[],
  marketReserves: MarketReserveMap,
  options: ScanOptions,
  bonusByReserve?: Map<string, number>,
  storedHealthByPubkey?: Map<string, number>,
): { candidates: LiquidatableCandidate[]; nearMiss: LiquidatableCandidate[]; skipped: FunnelSkipReason } {
  const candidates: LiquidatableCandidate[] = [];
  const nearMiss: LiquidatableCandidate[] = [];
  const skipped: FunnelSkipReason = { nonVanilla: 0, healthy: 0, outOfBand: 0, noFlashDebt: 0, staleOracle: 0, belowFloor: 0 };

  for (const obligation of obligations) {
    if (!isVanillaObligation(obligation)) {
      skipped.nonVanilla += 1;
      continue;
    }
    // DUE / band classification MUST use the live recompute, not the stored scaled-factor
    // health. The stored debtSf/unhealthySf are snapshots from the obligation's last on-chain
    // refresh and go stale as prices move (observed: stored 0.99995 vs live 1.35 — the program
    // rejected every such target with Custom 6016 ObligationHealthy). The program recomputes
    // health fresh at liquidation, so the hydrated SDK recompute (healthFactor) is the arbiter.
    // storedHealthByPubkey is used only as fallback when the obligation cannot be hydrated.
    const health = Number.isFinite(healthFactor(obligation))
      ? healthFactor(obligation)
      : storedHealthByPubkey?.get(obligation.obligationAddress.toString()) ?? healthFactor(obligation);
    if (health >= options.healthWatch) {
      skipped.healthy += 1;
      continue;
    }
    let candidate: LiquidatableCandidate;
    try {
      candidate = obligationToCandidate(obligation, marketReserves);
      candidate.healthFactor = health;
    } catch {
      skipped.healthy += 1;
      continue;
    }
    const debtReserve = marketReserves.get((candidate.repayDebt ?? candidate.largestDebt).reserve);
    const debtUsd = (candidate.repayDebt ?? candidate.largestDebt).amountUsd;
    // minDebtUsd/maxDebtUsd == 0 disables the debt band (full-market research mode).
    if (options.minDebtUsd > 0 && debtUsd < options.minDebtUsd) {
      skipped.outOfBand += 1;
      continue;
    }
    if (options.maxDebtUsd > 0 && debtUsd > options.maxDebtUsd) {
      skipped.outOfBand += 1;
      continue;
    }
    if (!debtReserve || !debtReserve.flashLoanEnabled || debtReserve.availableUsd < (candidate.estimatedRepayUsd ?? debtUsd)) {
      skipped.noFlashDebt += 1;
      continue;
    }
    if (!debtReserve.priceValid) {
      skipped.staleOracle += 1;
      continue;
    }
    // Bonus: paid in extra COLLATERAL — read from the priority-seized collateral
    // reserve (lowest liquidation threshold first, the program's own pair rule).
    // bonusByReserve (scan-side override) still wins when provided.
    const seizedCollateral = obligation.getDeposits()
      .map((deposit) => ({ deposit, info: marketReserves.get(deposit.reserveAddress) }))
      .filter((entry): entry is { deposit: (typeof entry)["deposit"]; info: NonNullable<(typeof entry)["info"]> } => Boolean(entry.info && entry.info.availableUsd > 0 && (entry.info.loanToValuePct ?? 1) > 0))
      .sort((a, b) => a.info.liquidationThresholdPct - b.info.liquidationThresholdPct)[0];
    const bonus = bonusByReserve?.get(seizedCollateral?.deposit.reserveAddress ?? candidate.largestDebt.reserve)
      ?? (seizedCollateral
        ? dynamicLiquidationBonus({
          healthFactor: health,
          liquidationThresholdPct: seizedCollateral.info.liquidationThresholdPct,
          ...bonusBounds(seizedCollateral.info, debtReserve),
        })
        : debtReserve.liquidationBonus);
    const caps = repayCaps(obligation, marketReserves);
    const totalDebtUsd = Number(candidate.borrowedValueUsd);
    const estProfit = estimateLiquidationProfit({
      debtUsd,
      totalDebtUsd,
      liquidationBonus: bonus,
      protocolLiquidationFeePct: seizedCollateral?.info.protocolLiquidationFeePct ?? 0,
      ...caps,
      ...(debtReserve.flashLoanFeeRate ? { flashLoanFeeRate: debtReserve.flashLoanFeeRate } : {}),
    });
    if (health < 1) {
      if (estProfit < options.profitFloorUsd) {
        skipped.belowFloor += 1;
        continue;
      }
      candidates.push({ ...candidate, estimatedProfitUsd: estProfit });
    } else if (health < options.nearMissHealth) {
      nearMiss.push({ ...candidate, estimatedProfitUsd: estProfit });
    }
  }

  candidates.sort((a, b) => (b.estimatedProfitUsd ?? 0) - (a.estimatedProfitUsd ?? 0));
  nearMiss.sort((a, b) => a.healthFactor - b.healthFactor);
  const cappedNearMiss = nearMiss.slice(0, 50);
  return { candidates, nearMiss: cappedNearMiss, skipped };
}

/** Pull the market-level knobs the prize math needs off a loaded market.
 * `Number(BN)` is safe here: BN's default `toString()` is radix 10 — the hex form
 * only appears through `toJSON`, which we never call. */
export interface MarketLevelSource {
  state: {
    liquidationMaxDebtCloseFactorPct?: unknown;
    insolvencyRiskUnhealthyLtvPct?: unknown;
    minFullLiquidationValueThreshold?: unknown;
    maxLiquidatableDebtMarketValueAtOnce?: unknown;
  };
}

export function readMarketLevelInfo(market: MarketLevelSource): MarketLevelInfo {
  const raw = (key: keyof MarketLevelSource["state"]): number | undefined => {
    const v = market.state[key];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const closeFactorPct = raw("liquidationMaxDebtCloseFactorPct");
  const insolvencyLtvPct = raw("insolvencyRiskUnhealthyLtvPct");
  const fullLiq = raw("minFullLiquidationValueThreshold");
  const maxAtOnce = raw("maxLiquidatableDebtMarketValueAtOnce");
  return {
    __marketCloseFactorPct: closeFactorPct !== undefined && closeFactorPct > 0 ? closeFactorPct : 100,
    ...(insolvencyLtvPct !== undefined && insolvencyLtvPct > 0
      ? { __marketInsolvencyLtvPct: insolvencyLtvPct }
      : {}),
    ...(fullLiq !== undefined && fullLiq > 0 ? { __marketFullLiqThresholdUsd: fullLiq } : {}),
    ...(maxAtOnce !== undefined && maxAtOnce > 0 ? { __marketMaxAtOnceUsd: maxAtOnce } : {}),
  };
}

export function buildMarketReserveMap(
  market: {
    getReserves(): Array<{
      address: string;
      getTokenSymbol(): string;
      getLiquidityMint(): { toString(): string };
      getMintDecimals(): number;
      getLiquidityAvailableAmount(): { toFixed(digits?: number): string };
      getOracleMarketPrice(): { div(value: number | string): { toFixed(digits?: number): string } };
      hasValidOraclePrice(): boolean;
      getFlashLoanFee(): { toString(): string };
      state: { config: { fees: { flashLoanFeeSf: { toString(): string } }; minLiquidationBonusBps: number; maxLiquidationBonusBps: number; badDebtLiquidationBonusBps?: number; liquidationThresholdPct: number; protocolLiquidationFeePct?: number; borrowFactorPct?: { toString(): string }; loanToValuePct?: number } };
    }>;
  },
  marketLevel?: MarketLevelInfo,
): MarketReserveMap {
  const map = new Map<string, MarketReserveInfo & Partial<MarketLevelInfo>>();
  // The market-level numbers travel ON the map (key "__market__") so every
  // consumer (obligationToCandidate, filterLiquidatable) prices the prize with
  // the program's real repay cap without threading a param through all callers.
  const level: MarketLevelInfo = { __marketCloseFactorPct: marketLevel?.__marketCloseFactorPct ?? 100 };
  if (marketLevel?.__marketInsolvencyLtvPct !== undefined) level.__marketInsolvencyLtvPct = marketLevel.__marketInsolvencyLtvPct;
  if (marketLevel?.__marketFullLiqThresholdUsd !== undefined) level.__marketFullLiqThresholdUsd = marketLevel.__marketFullLiqThresholdUsd;
  if (marketLevel?.__marketMaxAtOnceUsd !== undefined) level.__marketMaxAtOnceUsd = marketLevel.__marketMaxAtOnceUsd;
  map.set("__market__", level as MarketReserveInfo & Partial<MarketLevelInfo>);
  for (const reserve of market.getReserves()) {
    const flashLoanFeeRate = Number(reserve.getFlashLoanFee().toString());
    const liquidityAvailable = Number(reserve.getLiquidityAvailableAmount().toFixed(0));
    const oraclePrice = Number(reserve.getOracleMarketPrice().div(10 ** reserve.getMintDecimals()).toFixed(18));
    map.set(reserve.address, {
      symbol: reserve.getTokenSymbol(),
      liquidityMint: reserve.getLiquidityMint().toString(),
      flashLoanEnabled: reserve.state.config.fees.flashLoanFeeSf.toString() !== U64_MAX,
      flashLoanFeeRate,
      // Keep the reserve's dynamic bonus bounds; the live obligation health
      // selects the current value in dynamicLiquidationBonus().
      liquidationBonus: reserve.state.config.minLiquidationBonusBps / 10_000,
      liquidationBonusMax: reserve.state.config.maxLiquidationBonusBps / 10_000,
      ...(reserve.state.config.badDebtLiquidationBonusBps !== undefined ? { badDebtLiquidationBonus: reserve.state.config.badDebtLiquidationBonusBps / 10_000 } : {}),
      availableUsd: liquidityAvailable * oraclePrice,
      priceValid: reserve.hasValidOraclePrice(),
      liquidationThresholdPct: reserve.state.config.liquidationThresholdPct,
      protocolLiquidationFeePct: reserve.state.config.protocolLiquidationFeePct ?? 0,
      borrowFactorPct: Number(reserve.state.config.borrowFactorPct?.toString() ?? 100),
      loanToValuePct: reserve.state.config.loanToValuePct ?? 1,
    });
  }
  return map;
}

const U64_MAX = ((1n << 64n) - 1n).toString();
