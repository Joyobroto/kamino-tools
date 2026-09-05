import type { KaminoObligation } from "@kamino-finance/klend-sdk";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import type { LiquidatableCandidate, ScanOptions } from "./types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LIQUIDATION_BONUS_FALLBACK = 0.03;
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
}

export type MarketReserveMap = Map<string, MarketReserveInfo>;

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

export function estimateLiquidationProfit(debtUsd: number, liquidationBonus: number): number {
  const bonus = liquidationBonus > 0 ? liquidationBonus : LIQUIDATION_BONUS_FALLBACK;
  return debtUsd * bonus;
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
  return {
    obligation: obligation.obligationAddress,
    tag: obligation.obligationTag,
    healthFactor: healthFactor(obligation),
    depositedValueUsd: Number(stats.userTotalDeposit.toFixed(4)),
    borrowedValueUsd: Number(stats.userTotalBorrow.toFixed(4)),
    largestDebt,
    collateralSymbols: obligation.getDeposits().map((deposit) => {
      const info = marketReserves.get(deposit.reserveAddress);
      if (!info) return deposit.reserveAddress.slice(0, 4);
      return info.liquidityMint === WSOL_MINT ? "WSOL" : info.symbol;
    }),
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
): { candidates: LiquidatableCandidate[]; nearMiss: LiquidatableCandidate[]; skipped: FunnelSkipReason } {
  const candidates: LiquidatableCandidate[] = [];
  const nearMiss: LiquidatableCandidate[] = [];
  const skipped: FunnelSkipReason = { nonVanilla: 0, healthy: 0, outOfBand: 0, noFlashDebt: 0, staleOracle: 0, belowFloor: 0 };

  for (const obligation of obligations) {
    if (!isVanillaObligation(obligation)) {
      skipped.nonVanilla += 1;
      continue;
    }
    const health = healthFactor(obligation);
    if (health >= options.healthWatch) {
      skipped.healthy += 1;
      continue;
    }
    let candidate: LiquidatableCandidate;
    try {
      candidate = obligationToCandidate(obligation, marketReserves);
    } catch {
      skipped.healthy += 1;
      continue;
    }
    const debtReserve = marketReserves.get(candidate.largestDebt.reserve);
    const debtUsd = candidate.largestDebt.amountUsd;
    // minDebtUsd/maxDebtUsd == 0 disables the debt band (full-market research mode).
    if (options.minDebtUsd > 0 && debtUsd < options.minDebtUsd) {
      skipped.outOfBand += 1;
      continue;
    }
    if (options.maxDebtUsd > 0 && debtUsd > options.maxDebtUsd) {
      skipped.outOfBand += 1;
      continue;
    }
    if (!debtReserve || !debtReserve.flashLoanEnabled || debtReserve.availableUsd < debtUsd) {
      skipped.noFlashDebt += 1;
      continue;
    }
    if (!debtReserve.priceValid) {
      skipped.staleOracle += 1;
      continue;
    }
    const bonus = bonusByReserve?.get(candidate.largestDebt.reserve) ?? debtReserve.liquidationBonus;
    const estProfit = estimateLiquidationProfit(debtUsd, bonus);
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
      state: { config: { fees: { flashLoanFeeSf: { toString(): string } }; minLiquidationBonusBps: number; maxLiquidationBonusBps: number } };
    }>;
  },
): MarketReserveMap {
  const map = new Map<string, MarketReserveInfo>();
  for (const reserve of market.getReserves()) {
    const flashLoanFeeRate = Number(reserve.getFlashLoanFee().toString());
    const liquidityAvailable = Number(reserve.getLiquidityAvailableAmount().toFixed(0));
    const oraclePrice = Number(reserve.getOracleMarketPrice().div(10 ** reserve.getMintDecimals()).toFixed(6));
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
    });
  }
  return map;
}

const U64_MAX = ((1n << 64n) - 1n).toString();
