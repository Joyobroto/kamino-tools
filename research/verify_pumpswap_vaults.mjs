// pumpswap layout: WOFI@43, WSOL@75 → my guessed offsets (16/48/80/112) are WRONG. Fix:
// Looks like: mintA@43, mintB@75. Vault candidates: check 32-byte fields near: 107? 139?
// Try vault discovery: token accounts owned by POOL (memcmp owner):
import { readFileSync } from "node:fs";
import bs58 from "bs58";
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
const POOL = "Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N";
const res = await rpcCall("getProgramAccounts", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", {
  encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: POOL } }], withContext: false,
}]);
console.log("vaults owned by pool:", res.length);
for (const r of res) {
  const buf = Buffer.from(r.account.data[0], "base64");
  const mint = bs58.encode(buf.subarray(0, 32));
  console.log("  vault:", r.pubkey, "mint:", mint.slice(0, 10), "amount:", buf.readBigUInt64LE(64).toString());
  // find this vault pubkey offset in pool data:
  const vb = bs58.decode(r.pubkey);
  for (let off = 0; off <= 301 - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf.length && 0) {}
    // search in pool buffer instead:
  }
}
// search vault offsets in pool data:
const info = await rpcCall("getAccountInfo", [POOL, { encoding: "base64" }]);
const poolBuf = Buffer.from(info.value.data[0], "base64");
for (const r of res) {
  const vb = bs58.decode(r.pubkey);
  for (let off = 0; off <= 301 - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (poolBuf[off + i] !== vb[i]) { ok = false; break; }
    if (ok) console.log("vault", r.pubkey.slice(0, 8), "found at pool offset", off);
  }
}
