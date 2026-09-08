// We have 10 pages (~200 pools) + 160 new pools from earlier pulls. Analyze what we have locally first.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const files = {
  top: "/tmp/opencode/research/top_pools_20p.json",
  new: "/tmp/opencode/research/gecko_new_pools.json",
  lowvol: "/tmp/opencode/research/gecko_lowvol_pools.json",
};
let pools = [];
if (existsSync(files.top)) pools.push(...JSON.parse(readFileSync(files.top, "utf8")));
if (existsSync(files.new)) pools.push(...JSON.parse(readFileSync(files.new, "utf8")));
if (existsSync(files.lowvol)) pools.push(...JSON.parse(readFileSync(files.lowvol, "utf8")));
console.log("local pools total:", pools.length);
// dedupe by address
const seen = new Set();
pools = pools.filter(p => { if (seen.has(p.address)) return false; seen.add(p.address); return true; });
console.log("unique:", pools.length);
// group by baseMint
const byMint = {};
for (const p of pools) {
  const key = p.baseMint ?? p.name;
  (byMint[key] ??= []).push(p);
}
const multi = Object.entries(byMint).filter(([, v]) => v.length >= 2);
console.log("mints with 2+ pools:", multi.length);
let found = 0;
const candidates = [];
for (const [mint, plist] of multi) {
  const withLiq = plist.filter(p => (p.liqUsd ?? 0) > 100);
  if (withLiq.length < 2) continue;
  const prices = withLiq.map(p => p.price).filter(x => x > 0);
  if (!prices.length) continue;
  const max = Math.max(...prices), min = Math.min(...prices);
  if (max / min > 1.5) {
    found++;
    candidates.push({ mint, pools: withLiq, ratio: max / min });
    console.log(`\n⭐ ${plist[0].name} ratio=${(max / min).toFixed(2)}x`);
    for (const p of withLiq) console.log(`   ${(p.dex ?? "?").padEnd(14)} price=$${p.price.toPrecision(4)} liq=$${Math.round(p.liqUsd ?? 0)} vol24h=$${Math.round(p.vol24hUsd ?? p.vol24 ?? 0)}`);
  }
}
console.log("\nmismatch candidates (ratio>1.5x):", found, "of", multi.length);
writeFileSync("/tmp/opencode/research/mismatch_candidates.json", JSON.stringify(candidates));
