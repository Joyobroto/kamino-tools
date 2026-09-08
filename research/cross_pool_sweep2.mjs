// Retry sweep with longer backoff (Gecko free tier: 30 calls/min — we hit it with 2.2s pacing + retries)
import { readFileSync } from "node:fs";
const fs = await import("node:fs");
const NET = "https://api.geckoterminal.com/api/v2/networks/solana";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
async function get(url) {
  for (let a = 1; a <= 8; a++) {
    const wait = Math.max(0, 2500 - (Date.now() - lastCall));
    await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429) { console.error("429, backing 8s"); await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  throw new Error("rate limited");
}
const all = [];
for (let page = 1; page <= 20; page++) {
  const j = await get(`${NET}/pools?include=base_token,quote_token,dex&page=${page}`);
  for (const p of j.data ?? []) {
    const a = p.attributes;
    all.push({
      address: a.address, name: a.name, dex: p.relationships?.dex?.data?.id,
      baseMint: p.relationships?.base_token?.data?.id ?? null,
      price: Number(a.base_token_price_usd || 0),
      vol24: Number(a.volume_usd?.h24 || 0),
      liqUsd: Number(a.reserve_in_usd || 0),
    });
  }
  if (page % 5 === 0) console.error(`page ${page}… ${all.length} pools`);
}
console.log("pools pulled:", all.length);
fs.writeFileSync("/tmp/opencode/research/top_pools_20p.json", JSON.stringify(all));
const byMint = {};
for (const p of all) if (p.baseMint) (byMint[p.baseMint] ??= []).push(p);
const multi = Object.entries(byMint).filter(([, v]) => v.length >= 2);
console.log("mints with 2+ pools:", multi.length);
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
