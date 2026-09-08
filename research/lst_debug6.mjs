// EVEN classic GPA memcmp@181 returns 0 — but the pool Hp53XEtt HAS JitoSOL at 181!
// → memcmp bytes param must be processed differently. Maybe Helius memcmp requires the bytes
// in a specific encoding (base58 string should work...). Test: memcmp@101 with WSOL (calibrated earlier — that WORKED for the SOL/USDC pool discovery):
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const WSOL = "So11111111111111111111111111111111111111112";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe";
// WSOL@101 (calibrated true):
const r1 = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 101, bytes: WSOL } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("GPA memcmp@101 WSOL:", r1.length);
await sleep(2000);
// JitoSOL@181:
const r2 = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 181, bytes: JITO } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("GPA memcmp@181 JitoSOL:", r2.length);
await sleep(2000);
// JitoSOL anywhere — use base64 bytes instead? memcmp 'bytes' accepts base58 normally.
// Wait: Hp53XEtt field@101=WSOL. So it SHOULD appear in r1. Is Hp53XEtt in r1?
console.log("Hp53XEtt in WSOL@101 result:", r1.some(x => x.pubkey === "Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp"));
