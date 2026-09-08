// Prefix doesn't help. But WSOL@101 worked... difference: offset 101 vs 181?
// Hypothesis: Helius memcmp index only covers the FIRST ~175 bytes of account data?
// Test: memcmp@101 with JitoSOL (wrong offset for this pool but tests the index):
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe";
const WSOL = "So11111111111111111111111111111111111111112";
// 1) JitoSOL at offset 101 (some pools have JitoSOL as token A):
const r1 = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 101, bytes: JITO } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("memcmp@101 JitoSOL:", r1.length);
// 2) WSOL at offset 181 (pairs where SOL is token B):
const r2 = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 181, bytes: WSOL } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("memcmp@181 WSOL:", r2.length);
