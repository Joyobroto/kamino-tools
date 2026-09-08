// Decode the REAL Raydium SOL/USDC AMMv4 pool (752 bytes) — derive layout empirically
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
const key = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const info = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("SOL/USDC AMMv4, len:", buf.length);
// scan for known mints at any offset
const KNOWN = {
  "So11111111111111111111111111111111111111112": "WSOL",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
};
const found = {};
for (const [mint, sym] of Object.entries(KNOWN)) {
  const bytes = bs58.decode(mint);
  outer: for (let off = 0; off <= buf.length - 32; off++) {
    if (buf[off] !== bytes[0]) continue;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== bytes[i]) continue outer;
    found[sym] = off;
  }
}
console.log("mint offsets:", JSON.stringify(found));
// dump first 320 bytes hex with offsets
for (let i = 0; i < 320; i += 32) console.log(String(i).padStart(4), buf.subarray(i, i + 32).toString("hex"));
