// WrongSize on encoding param — fix: use encoding: "base64" inside config correctly
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
const tas = await rpcCall("getTokenAccountsByOwner", [POOL, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP" }, { encoding: "jsonParsed" }]);
console.log("token accounts:", tas.value.length);
for (const t of tas.value) {
  const p = t.account.data.parsed.info;
  console.log("  acct:", t.pubkey, "mint:", p.mint.slice(0, 8) + "…", "amount:", p.tokenAmount.amount);
  const taBytes = bs58.decode(t.pubkey);
  outer: for (let off = 0; off <= buf.length - 32; off++) {
    if (buf[off] !== taBytes[0]) continue;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== taBytes[i]) continue outer;
    console.log("    ↳ pubkey found at offset:", off);
  }
}
// Also locate WSOL/USDC mint offsets:
for (const [sym, mint] of [["WSOL", "So11111111111111111111111111111111111111112"], ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]]) {
  const b = bs58.decode(mint);
  outer2: for (let off = 0; off <= buf.length - 32; off++) {
    if (buf[off] !== b[0]) continue;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== b[i]) continue outer2;
    console.log(`${sym} mint at offset:`, off);
  }
}
