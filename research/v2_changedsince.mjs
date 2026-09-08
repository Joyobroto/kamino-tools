// Test changedSinceSlot: how many accounts return when asking for only-changed since last slot?
import { readFileSync } from "node:fs";
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
// get current slot
const slot = await call("getSlot", []);
console.log("current slot:", slot);
// changed accounts on pumpswap pools since (slot - 400) ≈ ~3min ago:
for (const back of [400, 2000]) {
  const t0 = Date.now();
  let key = null, count = 0, pages = 0, firstFew = [];
  do {
    const page = await call("getProgramAccountsV2", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", {
      encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 },
      limit: 10000, changedSinceSlot: slot - back, ...(key ? { paginationKey: key } : {}),
    }]);
    count += page.accounts.length;
    if (page.accounts.length && firstFew.length < 3) firstFew.push(...page.accounts.slice(0, 3).map(a => a.pubkey));
    key = page.paginationKey;
    pages++;
  } while (key && pages < 100);
  console.log(`changed since slot-${back} (${back / 2.5}s of chain time): ${count} accounts in ${pages} pages, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("  sample:", firstFew);
}
