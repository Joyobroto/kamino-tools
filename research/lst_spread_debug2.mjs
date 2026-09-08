// Jup rate: 1.2996 SOL per JitoSOL?? REAL JitoSOL rate ≈ 1.15-1.20. 2.6 SOL for 2 JitoSOL is 2x off!
// → the "real" JitoSOL mint from Jupiter token search might be a FAKE/unofficial clone
// (verified badge but impostor?), OR JitoSOL rate really... no. Check what mint the orca pool
// ACTUALLY holds (from earlier: pool tokenB = J1toso1uCk...GCPn = the same one).
// And Jupiter quoted 1.2996 for it. If the deepest POOL price says ~1.19, spread=86% would be real?!
// NO WAY — get the orca pool vault balances properly:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const POOL = "Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp";
const info = await call("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
const vA = bs58.encode(buf.subarray(133, 165));
const vB = bs58.encode(buf.subarray(213, 245));
console.log("vaultA@133:", vA, "\nvaultB@213:", vB);
const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
for (const [i, b] of (bals.value ?? []).entries()) {
  const p = b?.data?.parsed?.info;
  console.log(`vault${i}: mint=${p?.mint?.slice(0, 12)} amount=${p?.tokenAmount?.uiAmountString}`);
}
