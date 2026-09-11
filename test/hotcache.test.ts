import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { getCachedAltAddresses, getCachedBlockhash } from "../src/strategies/liquidation/hotcache.js";

test("failed ALT lookup clears in-flight entry and can recover", async (t) => {
  let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{
    calls++;
    return new Response(JSON.stringify(calls<=4?{result:{value:null}}:{result:{value:{data:{parsed:{info:{addresses:["11111111111111111111111111111111"]}}}}}}));
  });
  assert.deepEqual(await getCachedAltAddresses("https://rpc.invalid","table"),[]);
  assert.equal((await getCachedAltAddresses("https://rpc.invalid","table")).length,1);
  assert.equal(calls,5);
});

test("blockhash cache separates RPC instances and explicit endpoints", async () => {
  let aCalls=0,bCalls=0;
  const a={getLatestBlockhash:()=>({send:async()=>{aCalls++;return {value:{blockhash:"a",lastValidBlockHeight:100n}};}})} as unknown as Rpc<SolanaRpcApi>;
  const b={getLatestBlockhash:()=>({send:async()=>{bCalls++;return {value:{blockhash:"b",lastValidBlockHeight:100n}};}})} as unknown as Rpc<SolanaRpcApi>;
  assert.equal((await getCachedBlockhash(a)).blockhash,"a");
  assert.equal((await getCachedBlockhash(b)).blockhash,"b");
  await getCachedBlockhash(a);assert.equal(aCalls,1);assert.equal(bCalls,1);
  await getCachedBlockhash(a,"https://a.invalid",true);
  await getCachedBlockhash(a,"https://a.invalid");assert.equal(aCalls,2);
});
