// Find a WSOL-containing AMMv4 pool by scanning slices of the first 500 pools (dataSlice 150 bytes covers mints)
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
const WSOL = "So11111111111111111111111111111111111111112";
// Fetch pools WITH data (first 200 bytes: covers vault+mints region 11..171)
const res = await rpcCall("getProgramAccounts", ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", {
  encoding: "base64", filters: [{ dataSize: 752 }], dataSlice: { offset: 0, length: 200 }, withContext: false,
}]);
console.log("fetched:", res.length);
let found = null;
for (const r of res) {
  const buf = Buffer.from(r.account.data[0], "base64");
  const s = bs58.encode(buf.subarray(75, 107));
  const s2 = bs58.encode(buf.subarray(107, 139));
  if (s === WSOL || s2 === WSOL) { found = { key: r.pubkey, buf }; break; }
}
if (!found) { console.log("no WSOL pool in sample; try different offset"); process.exit(0); }
console.log("WSOL pool:", found.key);
console.log("token0Mint@75 :", bs58.encode(found.buf.subarray(75, 107)));
console.log("token1Mint@107:", bs58.encode(found.buf.subarray(107, 139)));
console.log("dec0@139:", found.buf[139], "dec1@140:", found.buf[140]);
