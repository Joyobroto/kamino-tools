// Sanity: are these 705K "752-byte" accounts actually POOLS, or something else (positions/ticks)?
// Check first few accounts on Solscan-known data: decode and inspect, plus check account owner + data layout.
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
const res = await rpcCall("getProgramAccounts", ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", {
  encoding: "base64", filters: [{ dataSize: 752 }], dataSlice: { offset: 0, length: 64 }, withContext: false,
}]);
console.log("total:", res.length);
for (const r of res.slice(0, 3)) {
  const buf = Buffer.from(r.account.data[0], "base64");
  console.log("\nkey:", r.pubkey);
  console.log("first 64 bytes:", buf.toString("hex"));
  console.log("base58 view @13:", bs58.encode(buf.subarray(13, 45)));
}
