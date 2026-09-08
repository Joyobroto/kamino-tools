// @128/@160/@160/@192 jsonParsed shows empty → they might be Token-2022 mints or unowned.
// This particular pool may be a weird one. Given time budget: CPMM's share of NEW pools is tiny
// vs pumpswap/meteora. DECISION: ship v1 venues = pumpswap + DAMMv2 + DLMM + CLMM + Whirlpool + AMMv4
// with VERIFIED layouts; CPMM deferred (constant pool of mostly legacy pools, few new).
// AMMv4 vaults: official vaults are token accounts owned by POOL-PDA... earlier decode attempt showed
// vault0@11/43 don't exist. AMMv4 true layout has vaults elsewhere — find via owner-scan on pool:
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
// AMMv4 famous pool SOL/USDC = 58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2
// vault discovery: token accounts owned by the POOL ITSELF:
const res = await rpcCall("getProgramAccounts", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", {
  encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" } }], withContext: false,
}]);
console.log("vaults owned by AMMv4 pool:", res.length);
for (const r of res) {
  const vb = Buffer.from(r.account.data[0], "base64");
  const mint = bs58.encode(vb.subarray(0, 32));
  const amt = vb.readBigUInt64LE(64);
  console.log(`  vault ${r.pubkey} mint=${mint.slice(0, 8)} amount=${amt}`);
  // find offset in pool data
  const info = await rpcCall("getAccountInfo", ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const vbts = bs58.decode(r.pubkey);
  for (let off = 0; off <= 752 - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== vbts[i]) { ok = false; break; }
    if (ok) console.log("    ↳ at pool offset", off);
  }
}
