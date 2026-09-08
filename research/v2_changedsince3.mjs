// WEIRD: page1=1 account, page2=0, page3=3 — pagination returns inconsistent page sizes with
// changedSinceSlot (index still being built / different backends per page?).
// AND each page takes ~2.5s+ — 100 pages × 0.4s = 43s. The pagination with changedSinceSlot is FLAKY.
// DECISION: don't use changedSinceSlot. Instead: use plain V2 pagination but SPLIT the load —
// the real cost driver was meteora-damm-v2 (1.45M accounts, 83s). Check: is dataSize 1112 right?
// 1.45M POOLS for a DAMM program is insane — those must include non-pool accounts of same size.
// Verify: count pools on cpamdpZ with the VERIFIED mint at offset 168 — use memcmp on a known mint? Can't (unknown).
// Better: check what fraction of 1112B accounts on cpamdpZ have mints @168/200 by sampling:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(4000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
// sample 1112B accounts FULLY (no dataSlice) and check mint fields:
const page = await call("getProgramAccountsV2", ["cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", {
  encoding: "base64", filters: [{ dataSize: 1112 }], limit: 20,
}]);
console.log("sample accounts:", page.accounts.length);
for (const a of page.accounts.slice(0, 6)) {
  const buf = Buffer.from(a.account.data[0], "base64");
  const mintA = bs58.encode(buf.subarray(168, 200));
  const mintB = bs58.encode(buf.subarray(200, 232));
  console.log(`  ${a.pubkey.slice(0, 10)} mintA@168=${mintA.slice(0, 8)} mintB@200=${mintB.slice(0, 8)}`);
}
// ALSO: does the pubkey pattern tell? "1xxxx" prefixes = PDA positions?
const prefixes = {};
for (const a of page.accounts) {
  const p = a.pubkey[0];
  prefixes[p] = (prefixes[p] ?? 0) + 1;
}
console.log("first-char distribution of sample:", JSON.stringify(prefixes));
