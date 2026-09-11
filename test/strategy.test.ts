import assert from "node:assert/strict";
import test from "node:test";
import { address, createNoopSigner } from "@solana/kit";
import { loadStrategy } from "../src/strategy.js";

const signer = createNoopSigner(address("11111111111111111111111111111111"));

test("loads strategy instructions from strict JSON", async () => {
  const strategy = await loadStrategy("examples/strategy.example.json", signer);
  assert.equal(strategy.name, "replace-with-an-atomic-strategy");
  assert.equal(strategy.preInstructions.length, 0);
  assert.equal(strategy.instructions.length, 1);
  assert.equal(Buffer.from(strategy.instructions[0]!.data!).toString("utf8"), "kamino-tools");
});

test("defaults to a no-op strategy", async () => {
  const strategy = await loadStrategy(undefined, signer);
  assert.deepEqual(strategy, { name: "no-op", preInstructions: [], instructions: [] });
});

test("liquidation refresh instructions preserve the compute price and limit prefix", async () => {
  const { externalInstructionsToStrategy, upsertComputeBudget } = await import("../src/strategy.js");
  const programId = "ComputeBudget111111111111111111111111111111";
  const price = { programId, accounts: [], data: Buffer.from([3, 10, 0, 0, 0, 0, 0, 0, 0]).toString("base64") };
  const limit = { programId, accounts: [], data: Buffer.from([2, 192, 92, 21, 0]).toString("base64") };
  const replacement = {...limit, data: Buffer.from([2, 64, 66, 15, 0]).toString("base64")};
  const budget = upsertComputeBudget([price,limit], replacement);
  assert.equal(budget.length, 2);
  assert.deepEqual(budget, [price,replacement]);
  const refresh = {programAddress: address("11111111111111111111111111111111"), data: new Uint8Array([42])};
  const strategy = externalInstructionsToStrategy([], budget, signer, [refresh]);
  assert.deepEqual(strategy.preInstructions.map(ix => ix.data?.[0]), [3,2,42]);
  assert.equal(strategy.preInstructions[2], refresh);
});

test("flash chain retains budgets and encodes the shifted flash borrow index", async () => {
  const { buildFlashLoan } = await import("../src/kamino.js");
  const { externalInstructionsToStrategy } = await import("../src/strategy.js");
  const { Decimal } = await import("decimal.js");
  const pubkey = address("11111111111111111111111111111111");
  const budget = {programId:"ComputeBudget111111111111111111111111111111",accounts:[],data:Buffer.from([2,192,92,21,0]).toString("base64")};
  const refresh = {programAddress:pubkey,data:new Uint8Array([42])};
  const middle = {programId:pubkey,accounts:[],data:Buffer.from([43]).toString("base64")};
  const reserve = {
    address:pubkey,
    state:{config:{fees:{flashLoanFeeSf:0n}},liquidity:{supplyVault:pubkey,feeVault:pubkey}},
    getLiquidityMint:()=>pubkey,getMintDecimals:()=>6,getLiquidityTokenProgram:()=>pubkey,
    getLiquidityAvailableAmount:()=>new Decimal(10_000_000),
    calculateFlashLoanFees:()=>({protocolFees:new Decimal(0),referrerFees:new Decimal(0)}),
  } as unknown as Parameters<typeof buildFlashLoan>[0]["reserve"];
  const market = {
    state:{referralFeeBps:0},programId:address("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    getLendingMarketAuthority:async()=>pubkey,getAddress:()=>pubkey,
  } as unknown as Parameters<typeof buildFlashLoan>[0]["market"];
  const built=await buildFlashLoan({market,reserve,signer,amountBaseUnits:1_000_000n,
    tokenAccount:{address:pubkey,mint:pubkey,owner:pubkey,amount:0n,decimals:6},
    strategy:externalInstructionsToStrategy([middle],[budget],signer,[refresh]),
    setupInstructions:[refresh],
  });
  assert.equal(built.borrowInstructionIndex,3);
  assert.equal(built.instructions[0]!.programAddress,budget.programId);
  assert.deepEqual(Array.from(built.instructions[3]!.data!.slice(0,8)),[135,231,52,167,7,52,212,193]);
  assert.equal(built.instructions.at(-1)!.data![16],3);
});
