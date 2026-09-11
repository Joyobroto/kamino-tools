import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Decimal } from "decimal.js";
import { chooseRepayUsd, estimateCollateralForRepay, profitBaseUnitsToUsd } from "../src/strategies/liquidation/execute.js";

test("chooseRepayUsd applies default close factor and caps at largest debt", () => {
  assert.equal(chooseRepayUsd(100, 60), 50);
  assert.equal(chooseRepayUsd(100, 40), 40);
  assert.equal(chooseRepayUsd(100, 100), 50);
  assert.equal(chooseRepayUsd(100, 40, 1), 40);
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
