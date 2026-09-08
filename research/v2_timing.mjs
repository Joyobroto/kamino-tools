// Time the V2 listing per venue to size the cadence properly
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const VENUES = [
  ["pumpswap", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", 301],
  ["meteora-damm-v2", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", 1112],
  ["meteora-damm", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", 904],
  ["raydium-clmm", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", 1544],
  ["orca-whirlpool", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", 653],
];
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
for (const [name, prog, size] of VENUES) {
  const t0 = Date.now();
  let count = 0, key = null, pages = 0;
  do {
    const page = await call("getProgramAccountsV2", [prog, { encoding: "base64", filters: [{ dataSize: size }], dataSlice: { offset: 0, length: 0 }, limit: 10000, ...(key ? { paginationKey: key } : {}) }]);
    count += page.accounts.length;
    key = page.paginationKey;
    pages++;
  } while (key && pages < 200);
  console.log(`${name.padEnd(16)} ${String(count).padStart(7)} pools  ${pages} pages  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(500);
}
