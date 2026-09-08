import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
// find the full pool address starting with vD3W793v from our earlier scan? easier: re-run listing for that prefix
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
let key = null;
const targets = [];
do {
  const page = await call("getProgramAccountsV2", ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", {
    encoding: "base64", filters: [{ dataSize: 904 }], dataSlice: { offset: 88, length: 64 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
  }]);
  for (const a of page.accounts ?? []) {
    if (a.pubkey.startsWith("vD3W793v")) targets.push(a.pubkey);
  }
  key = page.paginationKey;
} while (key && targets.length < 3);
console.log("target pools:", targets);
for (const pool of targets) {
  const info = await call("getAccountInfo", [pool, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const mintA = bs58.encode(buf.subarray(88, 120));
  const mintB = bs58.encode(buf.subarray(120, 152));
  const vA = bs58.encode(buf.subarray(152, 184));
  const vB = bs58.encode(buf.subarray(184, 216));
  console.log(`\npool ${pool}`);
  console.log(`  mintA=${mintA === BONK ? "BONK" : mintA === USDC ? "USDC" : mintA === WSOL ? "WSOL" : mintA}`);
  console.log(`  mintB=${mintB === BONK ? "BONK" : mintB === USDC ? "USDC" : mintB === WSOL ? "WSOL" : mintB}`);
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
  for (const [i, b] of (bals.value ?? []).entries()) {
    const p = b?.data?.parsed?.info;
    console.log(`  vault${i}: mint=${p?.mint?.slice(0, 8)} amount=${p?.tokenAmount?.uiAmountString}`);
  }
  // mint decimals + supply to see if it's a BONK imposter:
  for (const m of [mintA, mintB]) {
    if (m === BONK || m === USDC || m === WSOL) continue;
    const mi = await call("getAccountInfo", [m, { encoding: "jsonParsed" }]);
    const p = mi.value?.data?.parsed?.info;
    console.log(`  ↳ unknown mint ${m} dec=${p?.decimals} supply=${p ? (Number(p.supply) / 10 ** p.decimals).toExponential(2) : "closed"}`);
    await sleep(2000);
  }
}
