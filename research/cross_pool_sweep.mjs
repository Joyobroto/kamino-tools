// SYSTEMATIC hidden-treasure sweep: group Gecko pools by mint pair, find LIVE cross-venue price mismatches.
// Method: for each token with 2+ pools (same pair mints), compare CURRENT implied prices using
// fresh on-chain vault data? Too heavy for all. First pass: use Gecko's OWN price field per pool —
// stale within hours but flags candidates; on-chain verify only the top mismatches.
import { readFileSync } from "node:fs";
const NET = "https://api.geckoterminal.com/api/v2/networks/solana";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let a = 1; a <= 5; a++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
// Enumerate pools by volume ASC is not allowed; but we can walk pages sorted by volume desc and go DEEP,
// OR use per-token pools. Better approach: enumerate top pools by volume (deep pagination, 20 pages),
// PLUS newly created pools (16 pages done earlier). Group by base mint.
const all = [];
for (let page = 1; page <= 20; page++) {
  const j = await get(`${NET}/pools?include=base_token,quote_token,dex&page=${page}`);
  const pools = j.data ?? [];
  for (const p of pools) {
    const a = p.attributes;
    all.push({
      address: a.address, name: a.name, dex: p.relationships?.dex?.data?.id,
      baseMint: p.relationships?.base_token?.data?.id ?? null,
      quoteMint: p.relationships?.quote_token?.data?.id ?? null,
      price: Number(a.base_token_price_usd || 0),
      vol24: Number(a.volume_usd?.h24 || 0),
      liqUsd: Number(a.reserve_in_usd || 0),
    });
  }
  await sleep(2200);
}
console.log("pools pulled:", all.length);
const fs = await import("node:fs");
fs.writeFileSync("/tmp/opencode/research/top_pools_20p.json", JSON.stringify(all));
// group by baseMint with >=2 pools
const byMint = {};
for (const p of all) if (p.baseMint) (byMint[p.baseMint] ??= []).push(p);
const multi = Object.entries(byMint).filter(([, v]) => v.length >= 2);
console.log("mints with 2+ pools:", multi.length);
// find price mismatches (price ratio > 2x) among pools with some liquidity on both sides
let found = 0;
for (const [mint, pools] of multi) {
  const withLiq = pools.filter(p => p.liqUsd > 100);
  if (withLiq.length < 2) continue;
  const prices = withLiq.map(p => p.price).filter(x => x > 0);
  if (!prices.length) continue;
  const max = Math.max(...prices), min = Math.min(...prices);
  if (max / min > 2) {
    found++;
    console.log(`\n⭐ ${pools[0].name} mint=${mint}`);
    for (const p of withLiq) console.log(`   ${p.dex.padEnd(14)} price=$${p.price.toPrecision(4)} liq=$${Math.round(p.liqUsd)} vol24h=$${Math.round(p.vol24)}`);
  }
}
console.log("\nmismatch candidates:", found, "of", multi.length, "multi-pool mints");
