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

test("the close factor is charged to the WHOLE obligation, not to one borrow", () => {
  // `max_liquidatable_borrowed_amount` = min(total_debt × cf, this_borrow). With
  // no total supplied we keep the old `this_borrow × cf`, so existing callers and
  // the one-borrow case are unchanged.
  assert.equal(sizing().amount, 100n);

  // $1100 obligation, $500 borrow, 10% close factor: allowed = min(110, 500) = 110,
  // i.e. 22% of this borrow's 1000 units instead of 10%.
  assert.equal(sizing({ totalBorrowValueUsd: new Decimal(1100) }).amount, 220n);

  // When total × cf exceeds the borrow, the WHOLE borrow is repayable — the
  // multi-borrow quota the old sizing silently threw away.
  assert.equal(sizing({ totalBorrowValueUsd: new Decimal(100_000) }).amount, 1_000n);

  // The collateral / vault caps still win over the bigger quota.
  assert.equal(
    sizing({ totalBorrowValueUsd: new Decimal(100_000), maxRepayFromCollateral: new Decimal(200) }).amount,
    200n,
  );

  // The dust full-liquidation band is untouched by the obligation-wide total.
  const dust = sizing({ borrowValueUsd: new Decimal("1.50"), totalBorrowValueUsd: new Decimal(1100) });
  assert.equal(dust.fullLiquidation, true);
  assert.equal(dust.amount, 1_000n);
});
