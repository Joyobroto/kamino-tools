// Test: are pagination cursors STABLE across full listings? If yes, we can resume from
// last-known cursor instead of re-listing everything: new accounts append AFTER cursor?
// Actually simpler robust approach: keep KNOWN set but only fetch pages until we hit
// a known-stable prefix — no. Helius pages aren't ordered by creation.
// PRAGMATIC SOLUTION: 
//   - pumpswap (126K pools, 78s) + meteora-damm (156K, 10s) + clmm (190K, 11s) + whirlpool (156K, 2s) = ~100s total
//   - cpamdpZ (1.45M, 83s) → EXCLUDE from the diff feed; monitor it via getSignaturesForAddress
//     sampled for "create" discriminators? 2857 tx/min is too many.
//   OR: accept ~100-180s cycle for ALL venues including cpamdpZ — new pools sit for minutes anyway
//   (article's own play: bolak-balik dengan modal $100 sampai rata — window is minutes not seconds).
// Test cursor stability first (maybe listing IS ordered and we can stop early):
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
// pumpswap: fetch 2 pages now, then 2 pages again — compare first pubkeys (ordered?)
const p1 = await call("getProgramAccountsV2", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 }, limit: 10000 }]);
console.log("first page first 3:", p1.accounts.slice(0, 3).map(a => a.pubkey.slice(0, 8)));
console.log("first page last 3:", p1.accounts.slice(-3).map(a => a.pubkey.slice(0, 8)));
await new Promise(r => setTimeout(r, 5000));
const p1b = await call("getProgramAccountsV2", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 }, limit: 10000 }]);
console.log("re-fetch first 3:", p1b.accounts.slice(0, 3).map(a => a.pubkey.slice(0, 8)));
console.log("same order?", JSON.stringify(p1.accounts.slice(0, 3).map(a => a.pubkey)) === JSON.stringify(p1b.accounts.slice(0, 3).map(a => a.pubkey)));
