// The gecko_pull run earlier wrote to /tmp/opencode/research/ but those files are missing (maybe cleaned).
// Re-pull new pools (works: new_pools endpoint) + store in repo research dir this time.
import { writeFileSync } from "node:fs";
const NET = "https://api.geckoterminal.com/api/v2/networks/solana";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
async function get(url) {
  for (let a = 1; a <= 8; a++) {
    const wait = Math.max(0, 3000 - (Date.now() - lastCall));
    await sleep(wait); lastCall = Date.now();
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(10000); continue; }
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  throw new Error("rate limited");
}
function row(p) {
  const a = p.attributes;
  return {
    address: a.address, name: a.name,
    dex: p.relationships?.dex?.data?.id ?? null,
    baseMint: p.relationships?.base_token?.data?.id ?? null,
    price: Number(a.base_token_price_usd || 0),
    vol24hUsd: Number(a.volume_usd?.h24 || 0),
    liqUsd: Number(a.reserve_in_usd || 0),
    createdAt: a.pool_created_at,
  };
}
let newPools = [];
for (let page = 1; page <= 10; page++) {
  try {
    const j = await get(`${NET}/new_pools?include=base_token,dex&page=${page}`);
    newPools.push(...(j.data ?? []).map(row));
  } catch (e) { console.error("new_pools page", page, e.message.slice(0, 50)); break; }
}
console.log("new pools:", newPools.length);
writeFileSync("research/gecko_new_pools.json", JSON.stringify(newPools));
console.log("saved research/gecko_new_pools.json");
