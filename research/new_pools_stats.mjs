import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
// Focus: pumpswap vs pump-fun migration pattern (bonding curve → pool): real liquidity both sides?
const interesting = pools.filter(p => (p.liqUsd ?? 0) >= 5000 && p.dex !== "pump-fun" && p.vol24hUsd !== undefined);
console.log("pools with ≥$5K liq (excluding bonding curves):", interesting.length);
for (const p of interesting.slice(0, 25)) {
  console.log(`${(p.dex ?? "?").padEnd(16)} ${p.name.padEnd(24)} price=$${p.price.toPrecision(4)} liq=$${Math.round(p.liqUsd)} vol24h=$${Math.round(p.vol24hUsd)}`);
}
console.log("\ndead (0 vol):", pools.filter(p => (p.vol24hUsd ?? 0) === 0).length, "/", pools.length);
console.log("liq>$1K:", pools.filter(p => (p.liqUsd ?? 0) > 1000).length);
