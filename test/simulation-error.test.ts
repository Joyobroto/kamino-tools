import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isHealthyLiquidationVeto } from "../src/strategies/liquidation/simulation-error.js";

test("recognizes Kamino healthy veto with numeric or serialized custom codes", () => {
  const logs = ["Program log: AnchorError occurred. Error Code: ObligationHealthy. Error Number: 6016. Error Message: Cannot liquidate healthy obligations."];
  for (const code of [6016, "6016", 6016n]) {
    assert.equal(isHealthyLiquidationVeto({ InstructionError: [9, { Custom: code }] }, logs), true);
  }
  assert.equal(isHealthyLiquidationVeto({ InstructionError: [9, { Custom: 6016 }] }, []), false);
  assert.equal(isHealthyLiquidationVeto({ InstructionError: [9, { Custom: 6009 }] }, logs), false);
  assert.equal(isHealthyLiquidationVeto(null, logs), false);
});

import { isClmmRouteFailure } from "../src/strategies/liquidation/simulation-error.js";
test("CLMM retry classification does not confuse Kamino codes with Raydium codes", () => {
  const error = {InstructionError:[0,{Custom:6035}]};
  assert.equal(isClmmRouteFailure(error,[],[{programAddress:"KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"}]),false);
  assert.equal(isClmmRouteFailure(error,[],[{programAddress:"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"}]),true);
});
