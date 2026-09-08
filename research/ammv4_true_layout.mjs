// The vaults decoded from @11/@43 don't exist → mints/vaults elsewhere. Search the buffer
// for TWO 32-byte sequences that are actual token accounts (owner = pool, mint = WSOL/USDC).
// Approach: get all token accounts owned by the POOL pubkey, then find their byte offsets in the buffer.
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
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const info = await rpcCall("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
// token accounts owned by pool:
const tas = await rpcCall("getTokenAccountsByOwner", [POOL, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP" }, { encoding: "base64" }]);
console.log("token accounts owned by pool:", tas.value.length);
for (const t of tas.value) {
  const tbuf = Buffer.from(t.account.data[0], "base64");
  const mint = bs58.encode(tbuf.subarray(0, 32));
  const amount = tbuf.readBigUInt64LE(64);
  console.log("  acct:", t.pubkey, "mint:", mint.slice(0, 6), "amount:", amount.toString());
  // find offset of this token account pubkey in pool data
  const taBytes = bs58.decode(t.pubkey);
  outer: for (let off = 0; off <= buf.length - 32; off++) {
    if (buf[off] !== taBytes[0]) continue;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== taBytes[i]) continue outer;
    console.log("    ↳ found vault pubkey at buffer offset:", off);
  }
}
