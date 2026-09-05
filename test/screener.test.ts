import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import { parseObligationSlice } from "../src/strategies/liquidation/screener.js";
import { isRateLimitError } from "../src/strategies/liquidation/screener.js";
import {
  buildMarketReserveMap,
  estimateLiquidationProfit,
  filterLiquidatable,
  healthFactor,
  healthFactorFromSf,
  isVanillaObligation,
  obligationToCandidate,
  sfToUsd,
  type MarketReserveMap,
} from "../src/strategies/liquidation/filters.js";
import type { ScanOptions } from "../src/strategies/liquidation/types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const RESERVE_USDC = "ResUSDC11111111111111111111111111111111111";
const RESERVE_WSOL = "ResWSOL111111111111111111111111111111111111";

function fakeObligation(params: {
  tag?: number;
  collateralUsd?: number;
  liquidationLimitUsd?: number;
  borrowedUsd?: number;
  borrows?: Array<{ reserve: string; symbol: string; usd: number }>;
  deposits?: Array<{ reserve: string; symbol: string; usd: number }>;
  address?: string;
}) {
  const collateralUsd = params.collateralUsd ?? 0;
  const liquidationLimitUsd = params.liquidationLimitUsd ?? collateralUsd * 0.8;
  const borrowedUsd = params.borrowedUsd ?? 0;
  const borrows = params.borrows ?? [];
  const deposits = params.deposits ?? [];
  return {
    obligationAddress: params.address ?? "ObL1gAt1onAddress111111111111111111111111",
    obligationTag: params.tag ?? ObligationTypeTag.Vanilla,
    getBorrows: () => borrows.map((borrow) => ({
      reserveAddress: borrow.reserve,
      marketValueRefreshed: new Decimal(borrow.usd),
    })),
    getDeposits: () => deposits.map((deposit) => ({
      reserveAddress: deposit.reserve,
      marketValueRefreshed: new Decimal(deposit.usd),
    })),
    refreshedStats: {
      userTotalDeposit: new Decimal(collateralUsd),
      userTotalBorrow: new Decimal(borrowedUsd),
      userTotalBorrowBorrowFactorAdjusted: new Decimal(borrowedUsd),
      borrowLiquidationLimit: new Decimal(liquidationLimitUsd),
    },
  } as never;
}

function fakeMarketReserveMap(entries: Partial<Record<string, never>> | Array<{ address: string; symbol: string; liquidityMint?: string; flashLoanEnabled?: boolean; availableUsd?: number; priceValid?: boolean; liquidationBonus?: number }> = []): MarketReserveMap {
  const map = new Map<string, MarketReserveMap extends Map<string, infer V> ? V : never>();
  for (const entry of entries as Array<Record<string, unknown>>) {
    map.set(entry.address as string, {
      symbol: entry.symbol as string,
      liquidityMint: (entry.liquidityMint as string) ?? "M1ntAddress1111111111111111111111111111111",
      flashLoanEnabled: entry.flashLoanEnabled !== false,
      flashLoanFeeRate: 0,
      liquidationBonus: (entry.liquidationBonus as number) ?? 0.05,
      liquidationBonusMax: (entry.liquidationBonusMax as number) ?? ((entry.liquidationBonus as number) ?? 0.05) * 10,
      availableUsd: (entry.availableUsd as number) ?? 1_000_000,
      priceValid: entry.priceValid !== false,
    });
  }
  return map as MarketReserveMap;
}

const DEFAULTS: ScanOptions = {
  minDebtUsd: 100,
  maxDebtUsd: 5000,
  profitFloorUsd: 0.5,
  healthWatch: 1.5,
  nearMissHealth: 1.1,
};

test("isVanillaObligation accepts only vanilla tag", () => {
  assert.equal(isVanillaObligation(fakeObligation({ tag: 0 })), true);
  assert.equal(isVanillaObligation(fakeObligation({ tag: 1 })), false);
  assert.equal(isVanillaObligation(fakeObligation({ tag: 3 })), false);
});

test("healthFactor is liquidation limit over borrowed value", () => {
  const healthy = fakeObligation({ collateralUsd: 1000, liquidationLimitUsd: 800, borrowedUsd: 400 });
  assert.equal(healthFactor(healthy), 2);

  const unhealthy = fakeObligation({ collateralUsd: 1000, liquidationLimitUsd: 700, borrowedUsd: 800 });
  assert.ok(Math.abs(healthFactor(unhealthy) - 0.875) < 1e-9);
});

test("healthFactor is infinite when nothing is borrowed", () => {
  const empty = fakeObligation({ collateralUsd: 500, borrowedUsd: 0 });
  assert.equal(healthFactor(empty), Number.POSITIVE_INFINITY);
});

test("healthFactorFromSf matches hydrated computation scale (Sf / 1e18)", () => {
  // 900 USD debt, 787.5 USD unhealthy limit → health 0.875
  const debtSf = 900n * 10n ** 18n;
  const unhealthySf = 7875n * 10n ** 17n;
  assert.ok(Math.abs(healthFactorFromSf(debtSf, unhealthySf) - 0.875) < 1e-9);
});

test("sfToUsd divides by 1e18", () => {
  assert.equal(sfToUsd(1234n * 10n ** 18n), 1234);
  assert.equal(sfToUsd(0n), 0);
});

test("estimateLiquidationProfit uses reserve bonus when available", () => {
  assert.equal(estimateLiquidationProfit(1000, 0.05), 50);
});

test("estimateLiquidationProfit falls back to 3 percent", () => {
  assert.equal(estimateLiquidationProfit(1000, 0), 30);
});

test("parseObligationSlice reads debt, unhealthy Sf, and ADL fields from dataSlice bytes", () => {
  const buffer = Buffer.alloc(130);
  buffer.writeBigUInt64LE(900n * 10n ** 18n & 0xFFFFFFFFFFFFFFFFn, 0);
  buffer.writeBigUInt64LE((900n * 10n ** 18n) >> 64n, 8);
  buffer.writeBigUInt64LE(7875n * 10n ** 17n & 0xFFFFFFFFFFFFFFFFn, 48);
  buffer.writeBigUInt64LE((7875n * 10n ** 17n) >> 64n, 56);
  // ADL fields: adlTargetLtvPct @ slice offset 113, marginCallTs @ 120
  buffer.writeUInt8(75, 2321 - 2208);
  buffer.writeBigUInt64LE(1725400000n, 2328 - 2208);
  const parsed = parseObligationSlice(buffer.toString("base64"));
  assert.equal(parsed.debtSf, 900n * 10n ** 18n);
  assert.equal(parsed.unhealthySf, 7875n * 10n ** 17n);
  assert.equal(parsed.adlTargetLtvPct, 75);
  assert.equal(parsed.adlMarginCallTs, 1725400000);
});

test("parseObligationSlice defaults ADL fields to zero when unmarked", () => {
  const buffer = Buffer.alloc(130);
  buffer.writeBigUInt64LE(500n * 10n ** 18n & 0xFFFFFFFFFFFFFFFFn, 0);
  buffer.writeBigUInt64LE((500n * 10n ** 18n) >> 64n, 8);
  const parsed = parseObligationSlice(buffer.toString("base64"));
  assert.equal(parsed.adlTargetLtvPct, 0);
  assert.equal(parsed.adlMarginCallTs, 0);
});

test("parseObligationSlice rejects wrong-length slices", () => {
  assert.throws(() => parseObligationSlice(Buffer.alloc(10).toString("base64")));
});

test("obligationToCandidate maps positions and WSOL-aware symbols", () => {
  const marketReserves = fakeMarketReserveMap([
    { address: RESERVE_USDC, symbol: "USDC" },
    { address: RESERVE_WSOL, symbol: "SOL", liquidityMint: WSOL_MINT },
  ]);
  const obligation = fakeObligation({
    collateralUsd: 2000,
    borrowedUsd: 1500,
    borrows: [
      { reserve: RESERVE_USDC, symbol: "USDC", usd: 1500 },
      { reserve: "Other11111111111111111111111111111111111111", symbol: "USDT", usd: 100 },
    ],
    deposits: [{ reserve: RESERVE_WSOL, symbol: "SOL", usd: 2000 }],
  });
  const candidate = obligationToCandidate(obligation, marketReserves);
  assert.equal(candidate.largestDebt.symbol, "USDC");
  assert.equal(candidate.largestDebt.amountUsd, 1500);
  assert.deepEqual(candidate.collateralSymbols, ["WSOL"]);
});

test("filterLiquidatable keeps unhealthy in-band flash-fundable above-floor vanilla obligations", () => {
  const marketReserves = fakeMarketReserveMap([
    { address: RESERVE_USDC, symbol: "USDC", liquidationBonus: 0.05 },
  ]);
  const target = fakeObligation({
    address: "Target1111111111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 750,
    borrowedUsd: 900,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 900 }],
  });
  const healthy = fakeObligation({
    address: "Healthy11111111111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 800,
    borrowedUsd: 100,
  });
  const smallDebt = fakeObligation({
    address: "Small111111111111111111111111111111111111111",
    collateralUsd: 120,
    liquidationLimitUsd: 80,
    borrowedUsd: 90,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 90 }],
  });
  const noFlash = fakeObligation({
    address: "NoFlash1111111111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 750,
    borrowedUsd: 900,
    borrows: [{ reserve: "NoFlashReserve1111111111111111111111111", symbol: "XYZ", usd: 900 }],
  });
  const multiplyTag = fakeObligation({
    tag: 1,
    address: "Multiply111111111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 750,
    borrowedUsd: 900,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 900 }],
  });
  const nearMiss = fakeObligation({
    address: "NearMiss11111111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 1000,
    borrowedUsd: 950,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 950 }],
  });

  const { candidates, nearMiss: nearMisses, skipped } = filterLiquidatable(
    [target, healthy, smallDebt, noFlash, multiplyTag, nearMiss],
    marketReserves,
    DEFAULTS,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.obligation, "Target1111111111111111111111111111111111111");
  assert.ok((candidates[0]!.estimatedProfitUsd ?? 0) > 44);
  assert.equal(skipped.nonVanilla, 1);
  assert.equal(skipped.healthy, 1);
  assert.equal(skipped.outOfBand, 1);
  assert.equal(skipped.noFlashDebt, 1);
  assert.equal(nearMisses.length, 1);
  assert.equal(nearMisses[0]!.obligation, "NearMiss11111111111111111111111111111111111");
});

test("filterLiquidatable tracks near-miss between 1.0 and nearMissHealth", () => {
  const marketReserves = fakeMarketReserveMap([
    { address: RESERVE_USDC, symbol: "USDC", liquidationBonus: 0.05 },
  ]);
  const nearMiss = fakeObligation({
    address: "NearMiss11111111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 1000,
    borrowedUsd: 950,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 950 }],
  });
  const { candidates, nearMiss: nearMisses } = filterLiquidatable([nearMiss], marketReserves, DEFAULTS);
  assert.equal(candidates.length, 0);
  assert.equal(nearMisses.length, 1);
});

test("filterLiquidatable sorts candidates by estimated profit descending", () => {
  const marketReserves = fakeMarketReserveMap([
    { address: RESERVE_USDC, symbol: "USDC", liquidationBonus: 0.05 },
  ]);
  const small = fakeObligation({
    address: "SmallTarget1111111111111111111111111111111",
    collateralUsd: 1000,
    liquidationLimitUsd: 700,
    borrowedUsd: 800,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 300 }],
  });
  const large = fakeObligation({
    address: "LargeTarget11111111111111111111111111111111",
    collateralUsd: 4000,
    liquidationLimitUsd: 2800,
    borrowedUsd: 3200,
    borrows: [{ reserve: RESERVE_USDC, symbol: "USDC", usd: 2000 }],
  });

  const { candidates } = filterLiquidatable([small, large], marketReserves, DEFAULTS);
  assert.equal(candidates[0]!.obligation, "LargeTarget11111111111111111111111111111111");
  assert.equal(candidates[1]!.obligation, "SmallTarget1111111111111111111111111111111");
});

test("buildMarketReserveMap derives flashloan availability, bonus, and USD liquidity", () => {
  const market = {
    getReserves: () => [
      {
        address: RESERVE_USDC,
        getTokenSymbol: () => "USDC",
        getLiquidityMint: () => ({ toString: () => "M1ntUSDC111111111111111111111111111111" }),
        getMintDecimals: () => 6,
        getLiquidityAvailableAmount: () => ({ toFixed: () => "2000000" }),
        getOracleMarketPrice: () => ({ div: () => ({ toFixed: () => "1.000000" }) }),
        hasValidOraclePrice: () => true,
        getFlashLoanFee: () => 1,
        state: { config: { fees: { flashLoanFeeSf: { toString: () => "1000000000000" } }, minLiquidationBonusBps: 100, maxLiquidationBonusBps: 1000 } },
      },
      {
        address: RESERVE_WSOL,
        getTokenSymbol: () => "SOL",
        getLiquidityMint: () => ({ toString: () => WSOL_MINT }),
        getMintDecimals: () => 9,
        getLiquidityAvailableAmount: () => ({ toFixed: () => "0" }),
        getOracleMarketPrice: () => ({ div: () => ({ toFixed: () => "150.000000" }) }),
        hasValidOraclePrice: () => true,
        getFlashLoanFee: () => 1,
        state: { config: { fees: { flashLoanFeeSf: { toString: () => U64_MAX } }, minLiquidationBonusBps: 50, maxLiquidationBonusBps: 300 } },
      },
    ],
  } as never;

  const map = buildMarketReserveMap(market);
  const usdc = map.get(RESERVE_USDC)!;
  assert.equal(usdc.symbol, "USDC");
  assert.equal(usdc.flashLoanEnabled, true);
  assert.equal(usdc.liquidationBonus, 0.01, "screening bonus must use MIN bps (conservative, matches on-chain borderline liquidations)");
  assert.equal(usdc.liquidationBonusMax, 0.1);
  assert.equal(usdc.availableUsd, 2_000_000);
  const wsol = map.get(RESERVE_WSOL)!;
  assert.equal(wsol.symbol, "SOL");
  assert.equal(wsol.liquidityMint, WSOL_MINT);
  assert.equal(wsol.flashLoanEnabled, false);
  assert.equal(wsol.availableUsd, 0);
});

const U64_MAX = ((1n << 64n) - 1n).toString();

test("isRateLimitError detects HTTP 429 in the message", () => {
  assert.equal(isRateLimitError(new Error("HTTP error (429): ")), true);
  assert.equal(isRateLimitError(new Error("Too many requests for this endpoint")), true);
  assert.equal(isRateLimitError(new Error("fetch failed")), false);
});

test("isRateLimitError detects kit-wrapped SolanaError with statusCode in context", () => {
  // Reproduces the exact production failure seen in docker logs:
  // "Solana error #8100002; Decode this error by running npx @solana/errors decode ..."
  const kitError = new Error("Solana error #8100002; Decode this error by running `npx @solana/errors decode -- 8100002 '...'`");
  (kitError as Error & { context?: unknown }).context = { headers: {}, message: "", statusCode: 429 };
  assert.equal(isRateLimitError(kitError), true);

  const stringCode = new Error("Solana error #8100002");
  (stringCode as Error & { context?: unknown }).context = { statusCode: "429" };
  assert.equal(isRateLimitError(stringCode), true);

  const notRateLimit = new Error("Solana error #8100002");
  (notRateLimit as Error & { context?: unknown }).context = { statusCode: 500 };
  assert.equal(isRateLimitError(notRateLimit), false);
});
