import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { liquidationForObligation, resolveVetoFate, type ParsedTransaction } from "../src/strategies/liquidation/veto-forensics.js";
const klend = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const ix = { programId: klend, accounts: ["liquidator", "target"], data: getBase58Decoder().decode(Uint8Array.from([162,161,35,143,30,187,185,103])) };
const tx: ParsedTransaction = { slot: 1, meta: { err: null, innerInstructions: [{instructions:[ix]}] }, transaction: { message: { accountKeys: [{ pubkey: "payer" }], instructions: [] } } };
test("match actual target and liquidator in wrapper CPI, reject unrelated and reverted tx", () => {
  assert.deepEqual(liquidationForObligation(tx, "target"), { liquidator:"liquidator", feePayer:"payer" });
  assert.equal(liquidationForObligation(tx, "other"), null);
  assert.equal(liquidationForObligation({...tx,meta:{...tx.meta!,err:{Custom:6016}}}, "target"), null);
  const wrongIx = {...ix, data:getBase58Decoder().decode(new Uint8Array(8))};
  assert.equal(liquidationForObligation({...tx,meta:{err:null,innerInstructions:[{instructions:[wrongIx]}]}},"target"), null);
});

test("bounded history distinguishes old liquidation, missing data, and a recent winner", async (t) => {
  const trigger = 1_000_000;
  const params = {rpcUrl:"https://rpc.invalid",obligation:"target",triggeredAtMs:trigger};
  let results: unknown[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({result:results.shift()}),{status:200}));
  results = [[{signature:"old",blockTime:100,err:null}]];
  assert.equal((await resolveVetoFate(params)).outcome,"no-liquidation-found");
  results = [[{signature:"recent",blockTime:998,err:null}],tx];
  const found=await resolveVetoFate(params);
  assert.equal(found.outcome,"lost-race"); assert.equal(found.winner,"liquidator"); assert.equal(found.feePayer,"payer");
  assert.equal(found.raceLostAfterMs,-2000);
  results = [[{signature:"missing",blockTime:998,err:null}],null,[]];
  assert.equal((await resolveVetoFate(params)).outcome,"unknown");
  results = [[{signature:"new",blockTime:1100,err:null}]];
  assert.equal((await resolveVetoFate({...params,maxPages:1})).outcome,"unknown");
  results = [[]];
  assert.equal((await resolveVetoFate(params)).outcome,"no-liquidation-found");
});

test("RPC failure is unknown, never self-healed", async (t) => {
  t.mock.method(globalThis,"fetch",async()=>new Response("rate limited",{status:429}));
  assert.equal((await resolveVetoFate({rpcUrl:"https://rpc.invalid",obligation:"target",triggeredAtMs:1})).outcome,"unknown");
});

test("replay all seven public-RPC liquidation fixtures, including wrapper CPI", async () => {
  const { readFileSync } = await import("node:fs");
  const rows = JSON.parse(readFileSync(new URL("./fixtures/liquidations-2026-09-11.json", import.meta.url), "utf8")) as Array<{obligation:string;tx:ParsedTransaction}>;
  assert.equal(rows.length, 7);
  const expected = ["ewcjNU4X", "BPLjJYGN", "4NUiCMoJ", "BCusd3no", "Bcusd3ns", "BCuSd3h3", "PcUsdTQB"];
  rows.forEach((row,i) => {
    const match = liquidationForObligation(row.tx,row.obligation);
    assert.ok(match);
    assert.ok(match.liquidator.startsWith(expected[i]!));
    assert.equal(match.liquidator,match.feePayer);
  });
});
