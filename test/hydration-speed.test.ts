import { strict as assert } from "node:assert";
import { test } from "node:test";
import { address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { KaminoMarket, KaminoObligation, type LedgerInstant } from "@kamino-finance/klend-sdk";
import { Decimal } from "decimal.js";
import { hydrateShortlist, ledgerInstantAtSlot, refreshTrackedObligations, streamSnapshotFresh, streamLedgerInstant, type PreloadedMarket } from "../src/strategies/liquidation/screener.js";

const key = address("11111111111111111111111111111111");

test("hot checks reuse structural market data and avoid a refresh storm", async (t) => {
  let loads = 0;
  const rpc = {} as Rpc<SolanaRpcApi>;
  const oldMarket = { getAddress: () => key } as unknown as KaminoMarket;
  const market = { getAddress: () => key, getReserves: () => [], state: { liquidationMaxDebtCloseFactorPct: 10 } } as unknown as KaminoMarket;
  t.mock.method(KaminoMarket, "load", async () => { loads++; return market; });
  t.mock.method(KaminoObligation, "fromAccountData", () => ({ obligationTag: 0, obligationAddress: key }) as KaminoObligation);
  const params = { rpc, preloaded: { market: oldMarket, marketAddress: key, marketReserves: new Map(), loadedAt: Date.now() - 20_000 },
    pubkeys: [key], streamSnapshot: { pubkey: key, accountData: Buffer.alloc(3344), slot: 1n, receivedAt: Date.now() } };
  const results = await Promise.all([refreshTrackedObligations(params), refreshTrackedObligations(params)]);
  assert.equal(loads, 0);
  assert.ok(results.every(result => result.market === oldMarket));
});

test("single-account hydration does not schedule the old 500ms trailing sleep", async (t) => {
  let slept = false;
  const original = globalThis.setTimeout;
  t.mock.method(globalThis,"setTimeout", ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 500) slept = true;
    return original(...args);
  }) as typeof setTimeout);
  const rpc = {getMultipleAccounts:()=>({send:async()=>({value:[null]})})} as unknown as Rpc<SolanaRpcApi>;
  const market = {getAddress:()=>key} as unknown as PreloadedMarket["market"];
  await hydrateShortlist({rpc,market,ledgerInstant:{slot:1n,blockTime:1n as LedgerInstant["blockTime"]},pubkeys:[key],onProgress:()=>{}});
  assert.equal(slept,false);
});

test("fresh WS payload hydrates without getBlockTime/getMultipleAccounts on the race rail", async (t) => {
  let blockTimeCalls = 0;
  const rpc = {getBlockTime:()=>({send:async()=>{blockTimeCalls++;return 100n;}})} as unknown as Rpc<SolanaRpcApi>;
  const market = {getAddress:()=>key} as unknown as PreloadedMarket["market"];
  const fake = {
    obligationTag:0,obligationAddress:key,
    getBorrows:()=>[{reserveAddress:key,marketValueRefreshed:new Decimal(100)}],getDeposits:()=>[],
    refreshedStats:{userTotalDeposit:new Decimal(100),userTotalBorrow:new Decimal(100),userTotalBorrowBorrowFactorAdjusted:new Decimal(100),borrowLiquidationLimit:new Decimal(90)},
  } as unknown as KaminoObligation;
  t.mock.method(KaminoObligation,"fromAccountData",()=>fake);
  const preloaded={market,marketAddress:key,marketReserves:new Map(),loadedAt:Date.now()};
  const params={rpc,preloaded,pubkeys:[key],streamSnapshot:{pubkey:key,accountData:Buffer.alloc(3344),slot:1n,receivedAt:Date.now()}};
  const [a,b]=await Promise.all([refreshTrackedObligations(params),refreshTrackedObligations(params)]);
  assert.equal(blockTimeCalls,0);assert.equal(a.obligations.get(key),fake);assert.equal(b.market,market);
  assert.equal(a.candidates[0]?.healthFactor,0.9);
});

test("streamLedgerInstant uses the WS slot without an RPC roundtrip", () => {
  const instant = streamLedgerInstant({ pubkey: key, slot: 42n, receivedAt: Date.now() });
  assert.equal(instant.slot, 42n);
  assert.ok(Number(instant.blockTime) > 0);
});

test("stream snapshot rejects expired, future, mismatched or missing-slot data", () => {
  const snapshot={pubkey:key,accountData:Buffer.alloc(3344),slot:1n,receivedAt:1000};
  assert.equal(streamSnapshotFresh(snapshot,key,2499),true);
  assert.equal(streamSnapshotFresh(snapshot,key,2500),false);
  assert.equal(streamSnapshotFresh(snapshot,key,999),false);
  assert.equal(streamSnapshotFresh(snapshot,address("So11111111111111111111111111111111111111112"),1001),false);
  assert.equal(streamSnapshotFresh({pubkey:key,accountData:snapshot.accountData,receivedAt:1000},key,1001),false);
});

test("a missing slot block time is not cached permanently", async () => {
  let calls=0;
  const rpc={getBlockTime:()=>({send:async()=>++calls===1?null:100n})} as unknown as Rpc<SolanaRpcApi>;
  await assert.rejects(ledgerInstantAtSlot(rpc,5n));
  assert.deepEqual(await ledgerInstantAtSlot(rpc,5n),{slot:5n,blockTime:100n});
  assert.equal(calls,2);
});

test("oracle rail revalues cached account bytes with prices applied to the hydration market", async (t) => {
  let applied = false, decoded = false;
  const market = {getAddress:()=>key,getReserves:()=>[],state:{liquidationMaxDebtCloseFactorPct:10}} as unknown as KaminoMarket;
  const rpc = {} as Rpc<SolanaRpcApi>; // No RPC methods: a warm oracle evaluation must be local.
  t.mock.method(KaminoObligation,"fromAccountData",(...[markets, pubkey, bytes, instant]: Parameters<typeof KaminoObligation.fromAccountData>)=>{
    assert.equal(markets.get(key),market); assert.equal(applied,true); assert.equal(instant.slot,101n); decoded=true;
    return {obligationTag:1,obligationAddress:key} as KaminoObligation;
  });
  const preloaded={market,marketAddress:key,marketReserves:new Map(),loadedAt:Date.now()};
  const snapshots=new Map([[key,{pubkey:key,slot:100n,receivedAt:Date.now()-2000,accountData:Buffer.alloc(3344)}]]);
  await refreshTrackedObligations({rpc,preloaded,pubkeys:[key],snapshots,oracleTrigger:{pubkey:key,slot:101n,receivedAt:Date.now()},
    applyOraclePrices:(actual)=>{assert.equal(actual,market);applied=true;return true;}});
  assert.equal(decoded,true);
});

test("oracle bursts never fetch missing accounts or stale market snapshots", async (t) => {
  const market = {getAddress:()=>key,getReserves:()=>[],state:{liquidationMaxDebtCloseFactorPct:10}} as unknown as KaminoMarket;
  let rpcCalls = 0;
  const rpc = new Proxy({}, {get:()=>{rpcCalls++;throw new Error("oracle event attempted RPC");}}) as Rpc<SolanaRpcApi>;
  t.mock.method(KaminoMarket, "load", async () => {rpcCalls++;throw new Error("oracle event reloaded market");});
  for (const marketAge of [0,120_000]) {
    const preloaded={market,marketAddress:key,marketReserves:new Map(),loadedAt:Date.now()-marketAge};
    for (let i=0;i<100;i++) {
      const result=await refreshTrackedObligations({rpc,preloaded,pubkeys:[key],snapshots:new Map(),
        oracleTrigger:{pubkey:key,slot:101n,receivedAt:Date.now()},applyOraclePrices:()=>true});
      assert.equal(result.candidates.length,0);
    }
  }
  assert.equal(rpcCalls,0);
});
