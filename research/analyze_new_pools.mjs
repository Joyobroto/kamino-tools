// Analyze 200 newest pools: how many are meme/dead? Cross-reference mints across ALL pools we know.
import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
console.log("newest pools:", pools.length);
// dedupe mints
const byMint = {};
for (const p of pools) if (p.baseMint) (byMint[p.baseMint] ??= []).push(p);
const multi = Object.entries(byMint).filter(([, v]) => v.length >= 2);
console.log("mints appearing in 2+ NEW pools (double-listed = classic misprice setup):", multi.length);
for (const [mint, list] of multi) {
  const prices = list.map(p => p.price).filter(Boolean);
  if (prices.length >= 2) {
    const ratio = Math.max(...prices) / Math.min(...prices);
    console.log(`\n⭐ ${list[0].name} (${list.length} pools, price ratio ${ratio.toFixed(2)}x)`);
    for (const p of list) console.log(`   ${(p.dex ?? "?").padEnd(16)} price=$${p.price.toPrecision(4)} liq=$${Math.round(p.liqUsd)} created=${p.createdAt?.slice(0, 10)}`);
  } else {
    console.log(`\n• ${list[0].name} (${list.length} pools, no price yet)`);
    for (const p of list) console.log(`   ${(p.dex ?? "?").padEnd(16)} liq=$${Math.round(p.liqUsd)} created=${p.createdAt?.slice(0, 10)}`);
  }
}
// stats: how recent, how dead
const now = Date.now();
const ages = pools.map(p => p.createdAt ? (now - new Date(p.createdAt)) / 3600000 : null).filter(x => x !== null);
console.log("\nage (hours): min", Math.min(...ages).toFixed(1), "max", Math.max(...ages).toFixed(1));
const dead = pools.filter(p => p.vol24hUsd === 0).length;
console.log("pools with 0 volume:", dead, "/", pools.length);
const liqBuckets = { "<$1K": 0, "$1K-10K": 0, "$10K-100K": 0, ">$100K": 0 };
for (const p of pools) {
  const l = p.liqUsd ?? 0;
  if (l < 1000) liqBuckets["<$1K"]++;
  else if (l < 10000) liqBuckets["$1K-10K"]++;
  else if (l < 100000) liqBuckets["$10K-100K"]++;
  else liqBuckets[">$100K"]++;
}
console.log("liquidity buckets:", JSON.stringify(liqBuckets));
