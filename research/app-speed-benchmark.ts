/** Offline hydration benchmark. Artificial RPC latency, no network or wallet access. */
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { KaminoObligation } from "@kamino-finance/klend-sdk";
import { Decimal } from "decimal.js";
import { hydrateShortlist, refreshTrackedObligations, type PreloadedMarket } from "../src/strategies/liquidation/screener.js";

const delay = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));
const key=address("11111111111111111111111111111111");
const fakeObligation={obligationAddress:key,obligationTag:0,getBorrows:()=>[{reserveAddress:key,marketValueRefreshed:new Decimal(100)}],getDeposits:()=>[],refreshedStats:{userTotalBorrow:new Decimal(100),userTotalDeposit:new Decimal(100),userTotalBorrowBorrowFactorAdjusted:new Decimal(100),borrowLiquidationLimit:new Decimal(99)}} as unknown as KaminoObligation;
const original=KaminoObligation.fromAccountData;
KaminoObligation.fromAccountData=()=>fakeObligation;
const samples:{baselineMs:number;wsMs:number;targetedMs:number;baselineRpcCalls:number;wsRpcCalls:number;targetedRpcCalls:number}[]=[];
try {
  for(let i=0;i<5;i++) {
    let calls=0;
    const send=async<T>(value:T)=>{calls++;await delay(100);return value;};
    const rpc={getSlot:()=>({send:()=>send(123n)}),getBlockTime:()=>({send:()=>send(1000n)}),getMultipleAccounts:()=>({send:()=>send({value:[{data:[Buffer.alloc(3344).toString("base64"),"base64"]}]})})} as unknown as Rpc<SolanaRpcApi>;
    const market={getAddress:()=>key} as unknown as PreloadedMarket["market"];
    const preloaded={market,marketAddress:key,marketReserves:new Map(),loadedAt:Date.now()};
    const before=performance.now();
    // Previous serial hydration: slot -> block time -> account -> trailing pacing sleep.
    const slot=await rpc.getSlot().send(); const blockTime=await rpc.getBlockTime(slot).send();
    await hydrateShortlist({rpc,market,ledgerInstant:{slot,blockTime:blockTime!},pubkeys:[key],onProgress:()=>{}});
    await delay(500);
    const baselineMs=performance.now()-before,baselineRpcCalls=calls;
    calls=0;
    const started=performance.now();
    await refreshTrackedObligations({rpc,preloaded,pubkeys:[key],streamSnapshot:{pubkey:key,accountData:Buffer.alloc(3344),slot:123n,receivedAt:Date.now()}});
    const wsMs=performance.now()-started,wsRpcCalls=calls;
    calls=0;
    const targetedStart=performance.now();
    await hydrateShortlist({rpc,market,ledgerInstant:{slot,blockTime:blockTime!},pubkeys:[key],onProgress:()=>{}});
    samples.push({baselineMs,wsMs,targetedMs:performance.now()-targetedStart,baselineRpcCalls,wsRpcCalls,targetedRpcCalls:calls});
  }
} finally { KaminoObligation.fromAccountData=original; }
const median=(key:"baselineMs"|"wsMs"|"targetedMs")=>samples.map(s=>s[key]).sort((a,b)=>a-b)[2]!;
const result={kind:"offline synthetic hydration component benchmark",rpcDelayMs:100,iterations:5,note:"Not production latency or win-rate evidence. SDK decode is stubbed equally for both paths. Baseline reconstructs the removed serial reads and 500ms sleep.",medianMs:{before:median("baselineMs"),wsPayload:median("wsMs"),targetedAccountRead:median("targetedMs")},samples};
writeFileSync(new URL("../docs/APP_SPEED_BENCHMARK.json",import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
