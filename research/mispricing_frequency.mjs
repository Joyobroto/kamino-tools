// Measure how OFTEN fresh pools are mispriced vs other venues for the same mint.
// Method: for mints in new_pools with 2+ REAL pools (liq>$1K each, excluding pump-fun remnants),
// compare prices. Fresh migration pools vs any other venue.
import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
const byMint = {};
for (const p of pools) {
  if (!p.baseMint) continue;
  if (p.dex === "pump-fun" && (p.liqUsd ?? 0) < 1000) continue; // bonding remnant
  if ((p.liqUsd ?? 0) < 1000) continue;
  (byMint[p.baseMint] ??= []).push(p);
}
const multi = Object.entries(byMint).filter(([, l]) => l.length >= 2);
console.log("mints with 2+ real pools among newest 200:", multi.length);
for (const [mint, list] of multi) {
  const prices = list.map(p => p.price).filter(x => x > 0);
  const max = Math.max(...prices), min = Math.min(...prices);
  const ratio = min > 0 ? max / min : 0;
  console.log(`\n${list[0].name} (${mint.slice(0, 20)}…) ratio=${ratio.toFixed(3)}x`);
  for (const p of list) console.log(`   ${(p.dex ?? "?").padEnd(16)} $${p.price.toPrecision(4)} liq=$${Math.round(p.liqUsd)} vol=$${Math.round(p.vol24hUsd ?? 0)}`);
}
