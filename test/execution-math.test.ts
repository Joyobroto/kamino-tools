import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { chooseRepayBaseUnits, chooseRepayUsd, estimateCollateralForRepay, profitBaseUnitsToUsd } from "../src/strategies/liquidation/execute.js";

test("chooseRepayUsd applies default close factor and caps at largest debt", () => {
  assert.equal(chooseRepayUsd(100, 60), 50);
  assert.equal(chooseRepayUsd(100, 40), 40);
  assert.equal(chooseRepayUsd(100, 100), 50);
  assert.equal(chooseRepayUsd(100, 40, 1), 40);
});

const sizing = (over: Partial<Parameters<typeof chooseRepayBaseUnits>[0]> = {}) =>
  chooseRepayBaseUnits({
    borrowAmount: new Decimal(1_000),
    borrowValueUsd: new Decimal(500),
    closeFactorPct: 10,
    fullLiquidationThresholdUsd: new Decimal(2),
    debtReserveAvailable: new Decimal(1_000_000),
    maxRepayFromCollateral: new Decimal(1_000_000),
    maxRepayFromMarketCap: new Decimal(1_000_000),
    ...over,
  });

test("above the dust threshold the close factor sizes the repay", () => {
  const sized = sizing();
  assert.equal(sized.fullLiquidation, false);
  assert.equal(sized.amount, 100n); // 10% of 1000
  assert.equal(sized.infeasibleReason, undefined);
});

test("below min_full_liquidation_value_threshold the WHOLE borrow must be requested", () => {
  // Program reverts RepayTooSmallForFullLiquidation for anything under 100% here,
  // so the close factor must NOT be applied even though it would be smaller.
  const sized = sizing({ borrowValueUsd: new Decimal("1.50") });
  assert.equal(sized.fullLiquidation, true);
  assert.equal(sized.amount, 1_000n);
});

test("a required full liquidation is refused rather than silently capped", () => {
  const shortReserve = sizing({ borrowValueUsd: new Decimal(1), debtReserveAvailable: new Decimal(500) });
  assert.equal(shortReserve.amount, 0n);
  assert.match(shortReserve.infeasibleReason ?? "", /repay reserve only holds/);

  const shortCollateral = sizing({ borrowValueUsd: new Decimal(1), maxRepayFromCollateral: new Decimal(500) });
  assert.equal(shortCollateral.amount, 0n);
  assert.match(shortCollateral.infeasibleReason ?? "", /seizable collateral only covers/);
});

test("threshold of 0 disables the dust band and leaves the close factor in charge", () => {
  const sized = sizing({ borrowValueUsd: new Decimal("1.50"), fullLiquidationThresholdUsd: new Decimal(0) });
  assert.equal(sized.fullLiquidation, false);
  assert.equal(sized.amount, 100n);
});

test("a zero-value borrow never triggers the full-liquidation branch", () => {
  const sized = sizing({ borrowValueUsd: new Decimal(0) });
  assert.equal(sized.fullLiquidation, false);
  assert.equal(sized.amount, 100n);
});

test("above the threshold the repay is capped by reserve liquidity", () => {
  const sized = sizing({ debtReserveAvailable: new Decimal(42) });
  assert.equal(sized.fullLiquidation, false);
  assert.equal(sized.amount, 42n);
});

test("estimateCollateralForRepay applies bonus up and haircut down", () => {
  const est = estimateCollateralForRepay({
    repayAmountBaseUnits: 1_000_000n,
    debtPriceBase: new Decimal(1),
    collPriceBase: new Decimal(2),
    liquidationBonus: 0.01,
  });
  assert.equal(est, 503_990n);
});

test("estimateCollateralForRepay with zero bonus produces exactly (1-haircut) ratio", () => {
  const est = estimateCollateralForRepay({
    repayAmountBaseUnits: 1_000_000n,
    debtPriceBase: new Decimal("0.5"),
    collPriceBase: new Decimal("0.5"),
    liquidationBonus: 0,
  });
  assert.equal(est, 998_000n);
});

test("estimateCollateralForRepay floors, never rounds up", () => {
  const est = estimateCollateralForRepay({
    repayAmountBaseUnits: 1n,
    debtPriceBase: new Decimal(1),
    collPriceBase: new Decimal(3),
    liquidationBonus: 0.05,
  });
  assert.equal(est, 0n);
});

test("profit conversion applies base-unit pricing once for USDC and SOL", () => {
  assert.equal(profitBaseUnitsToUsd(1_000_000n, new Decimal("0.000001")), 1);
  assert.equal(profitBaseUnitsToUsd(1_000_000_000n, new Decimal("0.00000015")), 150);
  assert.equal(profitBaseUnitsToUsd(-50_000n, new Decimal("0.000001")), -0.05);
  assert.equal(profitBaseUnitsToUsd(50_000n, new Decimal("0.000001")), 0.05);
});

test("protocol fee takes half the bonus, preserving the repaid principal", () => {
  assert.equal(estimateCollateralForRepay({
    repayAmountBaseUnits: 100_000_000n,
    debtPriceBase: new Decimal("0.000001"),
    collPriceBase: new Decimal("0.000001"),
    liquidationBonus: 0.01,
    protocolLiquidationFeePct: 50,
  }), 100_299_000n);
});

test("protocol fee with zero bonus does not reduce principal", () => {
  assert.equal(estimateCollateralForRepay({
    repayAmountBaseUnits: 1_000_000n,
    debtPriceBase: new Decimal(1),
    collPriceBase: new Decimal(1),
    liquidationBonus: 0,
    protocolLiquidationFeePct: 50,
    precisionMarginBps: 0,
  }), 1_000_000n);
});
