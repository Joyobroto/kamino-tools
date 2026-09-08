// ANOMALY: dozens of mints have THE SAME pool listed TWICE with identical data (Maggie, WOFI, TRUMPCARD, ga...)
// That's Gecko's data structure (pool + mirrored entry), not two pools. Dedupe needed by address.
// 孙小圣 ratio 1.033x across two DIFFERENT addresses (43419 vs 43442 liq) — that one's real: TWO pumpswap pools
// for the same mint, 3.3% spread. Created within minutes of each other (copycat pool by someone else).
// Executable? Need on-chain vault check. This is exactly the "new liquidity added at wrong ratio" pattern!
import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
const sun = pools.filter(p => p.name?.startsWith("孙小圣"));
for (const p of sun) console.log(JSON.stringify({ addr: p.address, dex: p.dex, price: p.price, liq: p.liqUsd, vol: p.vol24hUsd, created: p.createdAt }));
