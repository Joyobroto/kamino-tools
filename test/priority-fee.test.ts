import { strict as assert } from "node:assert";
import { test } from "node:test";
import { choosePriorityFee, MAX_TIP_FRACTION_OF_PRIZE } from "../src/strategies/liquidation/execute.js";

test("priority off returns base fee", () => {
  const r = choosePriorityFee({ priorityMode: "off", prizeUsd: 500 });
  assert.equal(r.microlamportsPerCu, 0);
  assert.equal(r.tipUsd, 0);
  assert.equal(r.lane, "base-fee");
});

test("fixed mode uses the operator's flat rate verbatim", () => {
  const r = choosePriorityFee({ priorityMode: "fixed", microlamportsPerCu: 250_000 });
  assert.equal(r.microlamportsPerCu, 250_000);
  assert.ok(r.lane.includes("fixed"));
});

test("auto mode scales the bid with the prize", () => {
  const big = choosePriorityFee({ priorityMode: "auto", prizeUsd: 500 });
  const small = choosePriorityFee({ priorityMode: "auto", prizeUsd: 6 });
  assert.ok(big.microlamportsPerCu > small.microlamportsPerCu, "bigger prize must outbid smaller");
  assert.ok(big.lane.includes("kill-shot"));
  assert.ok(small.lane.includes("lane-1"));
});

test("auto mode never bids more than the 2% prize cap", () => {
  const r = choosePriorityFee({ priorityMode: "auto", prizeUsd: 30 });
  assert.ok(r.tipUsd <= 30 * MAX_TIP_FRACTION_OF_PRIZE + 1e-9);
});

test("auto mode tiny prizes still bid the minimum (beat base-fee spam)", () => {
  const r = choosePriorityFee({ priorityMode: "auto", prizeUsd: 0.3 });
  assert.ok(r.tipUsd > 0);
  assert.ok(r.microlamportsPerCu >= 1);
});