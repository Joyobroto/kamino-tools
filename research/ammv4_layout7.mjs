// Sweep the whole buffer for a WSOL match — fetch a handful of full accounts and scan every byte offset
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
const WSOL = bs58.decode("So11111111111111111111111111111111111111112");
const res = await rpcCall("getProgramAccounts", ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", {
  encoding: "base64", filters: [{ dataSize: 752 }], dataSlice: { offset: 0, length: 300 }, withContext: false,
}]);
console.log("pools:", res.length);
let hits = {};
for (const r of res.slice(0, 20000)) {
  const buf = Buffer.from(r.account.data[0], "base64");
  outer: for (let off = 0; off <= 300 - 32; off++) {
    if (buf[off] !== WSOL[0]) continue;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== WSOL[i]) continue outer;
    hits[off] = (hits[off] ?? 0) + 1;
  }
}
console.log("WSOL byte-match offsets in first 20K pools:", JSON.stringify(hits));
