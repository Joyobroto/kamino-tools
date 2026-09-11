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
  availableUsd: number;
  priceValid: boolean;
  /** The liquidation threshold (% of value) — drives the program's pair-priority. */
  liquidationThresholdPct: number;
  protocolLiquidationFeePct?: number;
  borrowFactorPct?: number;
  loanToValuePct?: number;
}

export type MarketReserveMap = Map<string, MarketReserveInfo & { __marketCloseFactorPct?: number }>;

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

/** Estimated margin after protocol share and flash fee, BEFORE swap/network costs.
 * Uses the executor's conservative selected-debt close-factor sizing.
 * This is screening metadata, not a quote or realized profit. */
export function estimateLiquidationProfit(input: {
  debtUsd: number;
  liquidationBonus: number;
  closeFactorPct?: number;
  flashLoanFeeRate?: number;
  protocolLiquidationFeePct?: number;
}): number {
  const bonus = Math.max(0, input.liquidationBonus);
  // The program caps the repay at close-factor × the debt position. Default 100
  // only when the caller has no market state (unit tests).
  const closeFactor = Math.max(0, Math.min(100, input.closeFactorPct ?? 100)) / 100;
  const repayUsd = input.debtUsd * closeFactor;
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
  const marketMeta = marketReserves.get("__market__");
  const closeFactorPct = marketMeta?.__marketCloseFactorPct ?? 100;
  // The liquidation bonus is paid in extra COLLATERAL — it comes from the
  // withdraw reserve's config (docs + program layout), not the debt side.
  // At screening time the pair isn't chosen yet: use the program's own priority
  // (lowest liquidation-threshold deposit is seized first) so the estimate matches
  // what the executor will actually pick.
  const seizedCollateral = obligation.getDeposits()
    .map((deposit) => ({ deposit, info: marketReserves.get(deposit.reserveAddress) }))
    .filter((entry): entry is { deposit: (typeof entry)["deposit"]; info: NonNullable<(typeof entry)["info"]> } => Boolean(entry.info && entry.info.availableUsd > 0 && (entry.info.loanToValuePct ?? 1) > 0))
    .sort((a, b) => a.info.liquidationThresholdPct - b.info.liquidationThresholdPct)[0];
  const bonus = seizedCollateral?.info.liquidationBonus ?? 0;
  const estimatedProfitUsd = estimateLiquidationProfit({
    debtUsd: repayDebt.amountUsd,
    liquidationBonus: bonus,
    protocolLiquidationFeePct: seizedCollateral?.info.protocolLiquidationFeePct ?? 0,
    ...(closeFactorPct !== 100 ? { closeFactorPct } : {}),
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
    estimatedRepayUsd: repayDebt.amountUsd * closeFactorPct / 100,
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
      ?? seizedCollateral?.info.liquidationBonus
      ?? debtReserve.liquidationBonus;
    const marketMeta = marketReserves.get("__market__");
    const closeFactorPct = marketMeta?.__marketCloseFactorPct ?? 100;
    const estProfit = estimateLiquidationProfit({
      debtUsd,
      liquidationBonus: bonus,
      protocolLiquidationFeePct: seizedCollateral?.info.protocolLiquidationFeePct ?? 0,
      ...(closeFactorPct !== 100 ? { closeFactorPct } : {}),
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
      state: { config: { fees: { flashLoanFeeSf: { toString(): string } }; minLiquidationBonusBps: number; maxLiquidationBonusBps: number; liquidationThresholdPct: number; protocolLiquidationFeePct?: number; borrowFactorPct?: { toString(): string }; loanToValuePct?: number } };
    }>;
  },
  marketCloseFactorPct?: number,
): MarketReserveMap {
  const map = new Map<string, MarketReserveInfo & { __marketCloseFactorPct?: number }>();
  // The market-level close factor travels ON the map (key "__market__") so every
  // consumer (obligationToCandidate, filterLiquidatable) prices the prize with
  // the program's real repay cap without threading a param through all callers.
  const closeFactorPct = marketCloseFactorPct ?? 100;
  map.set("__market__", { __marketCloseFactorPct: closeFactorPct } as MarketReserveInfo & { __marketCloseFactorPct?: number });
  for (const reserve of market.getReserves()) {
    const flashLoanFeeRate = Number(reserve.getFlashLoanFee().toString());
    const liquidityAvailable = Number(reserve.getLiquidityAvailableAmount().toFixed(0));
    const oraclePrice = Number(reserve.getOracleMarketPrice().div(10 ** reserve.getMintDecimals()).toFixed(18));
    map.set(reserve.address, {
      symbol: reserve.getTokenSymbol(),
      liquidityMint: reserve.getLiquidityMint().toString(),
      flashLoanEnabled: reserve.state.config.fees.flashLoanFeeSf.toString() !== U64_MAX,
      flashLoanFeeRate,
      // Conservative: borderline-healthy positions liquidate at the MINIMUM bonus
      // (empirically verified 2026-09-03: tx 3LUqFmbW… executed at min 100bps, not max 1000bps)
      liquidationBonus: reserve.state.config.minLiquidationBonusBps / 10_000,
      liquidationBonusMax: reserve.state.config.maxLiquidationBonusBps / 10_000,
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
