import { test } from "node:test";
import { strict as assert } from "node:assert";
import { address } from "@solana/kit";
import { OracleFeedCache } from "../src/strategies/liquidation/oracle-realtime.js";
import { heartbeatProblems, type Heartbeat } from "../src/strategies/liquidation/health.js";
const feed = address("11111111111111111111111111111111");
test("oracle updates reject earlier slots, absent slots and old receive times", () => {
  const cache = new OracleFeedCache(); const value = {feed,slot:100n,receivedAt:1000,data:Buffer.from([1])};
  assert.equal(cache.update(value),true);
  assert.equal(cache.update({...value,slot:99n,receivedAt:1001}),false);
  assert.equal(cache.update({...value,slot:101n,receivedAt:999}),false);
  assert.equal(cache.update({feed,receivedAt:1001,data:Buffer.from([2])}),false);
  assert.equal(cache.get(feed)?.data[0],1);
  assert.equal(cache.update({...value,slot:101n,receivedAt:1002}),true);
  assert.equal(cache.lastUpdateAt,1002);
});
test("healthcheck detects stale work and disconnected rails despite a live process", () => {
  const now = Date.now();
  const good: Heartbeat = {at:now,pid:process.pid,scanAt:now,hotAt:now,oracleAt:now,oracleLive:true,oracleSnapshotAgeMs:1000,wsLive:true,executorBusy:0,scanMaxAgeMs:300000};
  assert.deepEqual(heartbeatProblems(good,now),[]);
  assert.ok(heartbeatProblems({...good,at:now-31000},now).includes("watcher heartbeat stale"));
  assert.ok(heartbeatProblems({...good,scanAt:now-310000},now).includes("scan stalled"));
  assert.ok(heartbeatProblems({...good,oracleLive:false},now).includes("oracle stream stale"));
  assert.ok(heartbeatProblems({...good,oracleSnapshotAgeMs:Infinity},now).includes("oracle snapshot stale"));
});

test("HTTP oracle prime cannot overwrite a newer WS slot, including a concurrent update", async () => {
  const oracle = address("So11111111111111111111111111111111111111112");
  const cache = new OracleFeedCache();
  const market = {getReserves:()=>[{state:{config:{tokenInfo:{pythConfiguration:{price:oracle}}}}}]} as any;
  const account = {data:[Buffer.from([1]).toString("base64"),"base64"],owner:feed,lamports:1n,executable:false,space:1n};
  let release!: (value: any)=>void;
  let calls=0;
  const rpc={getMultipleAccounts:()=>({send:()=>{calls++;return new Promise(resolve=>{release=resolve;});}})};
  const first=cache.prime(rpc,market),second=cache.prime(rpc,market);
  cache.update({feed:oracle,slot:102n,receivedAt:Date.now(),data:Buffer.from([2])});
  release({context:{slot:100n},value:[account]}); await Promise.all([first,second]);
  assert.equal(calls,1);
  assert.equal(Buffer.from((cache as any).sdkAccounts.get(oracle).data[0],"base64")[0],2);
  assert.equal(cache.update({feed:oracle,slot:101n,receivedAt:Date.now(),data:Buffer.from([3])}),false);
  assert.ok(cache.snapshotAgeMs < 1000);
});

test("failed oracle priming is cooled down across repeated reconnects", async (t) => {
  let now=Date.now(),calls=0;
  t.mock.method(Date,"now",()=>now);
  const cache=new OracleFeedCache();
  const oracle=address("So11111111111111111111111111111111111111112");
  const market={getReserves:()=>[{state:{config:{tokenInfo:{pythConfiguration:{price:oracle}}}}}]} as any;
  const rpc={getMultipleAccounts:()=>({send:async()=>{calls++;throw new Error("HTTP 403");}})};
  await assert.rejects(cache.prime(rpc,market),/403/);
  for(let i=0;i<100;i++) await cache.prime(rpc,market);
  assert.equal(calls,1);
  now+=30_001;
  await assert.rejects(cache.prime(rpc,market),/403/);
  assert.equal(calls,2);
});

test("live oracle WS updates avoid periodic HTTP priming, but a stale feed still reconciles", async t => {
  let now = Date.now(), calls = 0; t.mock.method(Date, "now", () => now);
  const oracle = address("So11111111111111111111111111111111111111112");
  const cache = new OracleFeedCache();
  const market = { getReserves: () => [{ state: { config: { tokenInfo: { pythConfiguration: { price: oracle } } } } }] } as any;
  const rpc = { getMultipleAccounts: () => ({ send: async () => { calls++; return { context: { slot: 100n + BigInt(calls) }, value: [{ data: ["AQ==", "base64"], owner: feed, lamports: 1n, executable: false, space: 1n }] }; } }) };
  await cache.prime(rpc, market);
  for (let i = 0; i < 10; i++) {
    now += 10_000; cache.update({ feed: oracle, slot: 200n + BigInt(i), receivedAt: now, data: Buffer.from([2]) });
    await cache.prime(rpc, market);
  }
  assert.equal(calls, 1); assert.equal(cache.snapshotAgeMs, 0);
  now += 25_000; await cache.prime(rpc, market); assert.equal(calls, 2);
});
