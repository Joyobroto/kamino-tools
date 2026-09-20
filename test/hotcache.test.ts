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

import { selectLookupTables } from "../src/strategies/liquidation/hotcache.js";
import { address, AccountRole, type Instruction } from "@solana/kit";
test("ALT selection avoids single-key overhead, duplicates, signers and program IDs", () => {
  const key = (n: number) => address(("1".repeat(31) + String(n)) as string);
  const [payer,program,a,b,c] = [key(1),key(2),key(3),key(4),key(5)] as const;
  const ix: Instruction = {programAddress:program,accounts:[{address:payer,role:AccountRole.WRITABLE_SIGNER},...[a,b,c,program].map(address=>({address,role:AccountRole.READONLY}))]};
  const result = selectLookupTables([ix],payer,{small:[a],large:[a,b,program,payer],single:[c]});
  assert.deepEqual(Object.keys(result.tables),["large"]);
  assert.deepEqual(result.uncovered,[c]);
});

import { PublicKey } from "@solana/web3.js";
import { appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, blockhash, compileTransactionMessage } from "@solana/kit";

test("compiled ALT indexes preserve on-chain positions across large companion tables", () => {
  const key = (n: number) => address(new PublicKey(Uint8Array.from([n & 255, n >> 8, ...new Array(30).fill(7)])).toBase58());
  const payer = key(1000), program = key(1001);
  const tableA = key(1002), tableB = key(1003);
  const keysA = Array.from({ length: 240 }, (_, i) => key(i));
  const keysB = Array.from({ length: 240 }, (_, i) => key(i + 240));
  const used = [keysA[210]!, keysA[239]!, keysB[170]!, keysB[239]!];
  const ix: Instruction = { programAddress: program, accounts: used.map(address => ({ address, role: AccountRole.WRITABLE })) };
  const selected = selectLookupTables([ix], payer, { [tableA]: keysA, [tableB]: keysB });
  const message = appendTransactionMessageInstructions([ix], setTransactionMessageFeePayer(payer, createTransactionMessage({ version: 0 })));
  const compiled = compileTransactionMessage(compressTransactionMessageUsingAddressLookupTables(
    setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 100n }, message), selected.tables));
  const lookups = compiled.addressTableLookups!;
  assert.equal(lookups.length, 2);
  const original = { [tableA]: keysA, [tableB]: keysB };
  const resolved = lookups.flatMap(lookup => Array.from(lookup.writableIndexes).map(index => original[lookup.lookupTableAddress]![index]));
  assert.deepEqual(new Set(resolved), new Set(used));
  assert.deepEqual(selected.uncovered, []);
});

import { createKeyPairSignerFromBytes, getBase64EncodedWireTransaction } from "@solana/kit";
import { createSignedTransactionWithAltCached, primeAltCache } from "../src/strategies/liquidation/hotcache.js";

test("real signed packet fits with ALT compression and rejects uncovered oversized packets", async () => {
  const signer = await createKeyPairSignerFromBytes(new Uint8Array((await import("@solana/web3.js")).Keypair.fromSeed(new Uint8Array(32).fill(17)).secretKey));
  const key = (n: number) => address(new PublicKey(Uint8Array.from([n, ...new Array(31).fill(9)])).toBase58());
  const accounts = Array.from({ length: 45 }, (_, i) => key(i));
  const lookup = key(200);
  const rpc = { getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n } }) }) } as unknown as Rpc<SolanaRpcApi>;
  const ix: Instruction = { programAddress: key(201), accounts: accounts.map(address => ({ address, role: AccountRole.WRITABLE })), data: new Uint8Array(100) };
  const url = "https://packet-regression.invalid";
  primeAltCache(url, lookup, [key(100), ...accounts]);
  const signed = await createSignedTransactionWithAltCached(rpc, url, signer, [ix], [lookup]);
  assert.ok(Buffer.from(getBase64EncodedWireTransaction(signed), "base64").length < 1232);
  await assert.rejects(createSignedTransactionWithAltCached(rpc, url, signer, [ix], []), /1232-byte packet.*uncovered=/);
});
