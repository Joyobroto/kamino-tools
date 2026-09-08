// 20,000 tx/min on pumpswap — polling signatures is NOT viable for this volume (would need
// getSignaturesForAddress pagination every second + getTransaction per sig = RPC death).
// The RIGHT primitive: logsSubscription (WebSocket) filtered by "Instruction: CreatePool"/"initialize" 
// OR onAccountChange on pool programs. But for TONIGHT: measure how many NEW POOL ACCOUNTS appear
// per minute instead (dataSize-filtered GPA diff) — count accounts now vs 5 min later.
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpcCall(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(4000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited out");
}
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
// We know pool space = 301. Count now:
const t0 = await rpcCall("getProgramAccounts", [PUMPSWAP, { encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("pumpswap pools now:", t0.length);
await sleep(90_000);
const t1 = await rpcCall("getProgramAccounts", [PUMPSWAP, { encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("pumpswap pools +90s:", t1.length);
console.log("new pools per 90s:", t1.length - t0.length, "→ per hour:", ((t1.length - t0.length) * 40).toFixed(0));
