import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import { getCachedAltAddresses, getCachedBlockhash } from "../src/strategies/liquidation/hotcache.js";
import { createFailoverRpc } from "../src/rpc-failover.js";

const table = "ja2GCDWDMiNNFL79kS6Ev4wZznhgDDLxNsXwnXqKwYc";
const validTable = { owner: "AddressLookupTab1e1111111111111111111111111", data: { parsed: { info: {
  addresses: ["11111111111111111111111111111111"], deactivationSlot: 18446744073709551615n,
} } } };

test("failed ALT lookup fails explicitly, clears in-flight entry and can recover", async () => {
  let calls = 0;
  const rpc = { getAccountInfo: () => ({ send: async () => {
    calls++; if (calls === 1) throw new Error("rate limited");
    return { value: validTable };
  } }) } as unknown as Rpc<SolanaRpcApi>;
  await assert.rejects(getCachedAltAddresses("https://rpc.invalid", table, rpc), /ALT unavailable/);
  assert.equal((await getCachedAltAddresses("https://rpc.invalid", table, rpc)).length, 1);
  await getCachedAltAddresses("https://rpc.invalid", table, rpc);
  assert.equal(calls, 2);
});

test("ALT lookup rejects missing and deactivated tables instead of silently dropping compression", async () => {
  for (const value of [null, { ...validTable, data: { parsed: { info: { ...validTable.data.parsed.info, deactivationSlot: 123n } } } }]) {
    const rpc = { getAccountInfo: () => ({ send: async () => ({ value }) }) } as unknown as Rpc<SolanaRpcApi>;
    await assert.rejects(getCachedAltAddresses("https://invalid-table.invalid", table, rpc), /ALT unavailable/);
  }
});

test("concurrent ALT reads share one request through the provided RPC", async () => {
  let calls = 0;
  const rpc = { getAccountInfo: () => ({ send: async () => { calls++; return { value: validTable }; } }) } as unknown as Rpc<SolanaRpcApi>;
  await Promise.all(Array.from({ length: 5 }, () => getCachedAltAddresses("https://concurrent.invalid", table, rpc)));
  assert.equal(calls, 1);
});

test("ALT read survives a primary HTTP 429 using the configured fallback", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes("primary")) return new Response("max usage reached", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: {
      ...validTable, data: { parsed: { info: { ...validTable.data.parsed.info, deactivationSlot: "18446744073709551615" } } },
    } } }), { headers: { "Content-Type": "application/json" } });
  });
  const { rpc } = createFailoverRpc({ primaryUrl: "https://primary-alt.invalid", fallbackUrl: "https://fallback-alt.invalid" });
  assert.equal((await getCachedAltAddresses("https://primary-alt.invalid", table, rpc)).length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /fallback/);
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
