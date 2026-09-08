// GIGAANON case: pumpswap $0.000007553 (liq$16.5K) vs pump-fun bonding curve $0.00004215 (liq$0)
// Bonding curve price ≠ pool price — but at MIGRATION moment they equalize. This is the
// "new liquidity" battleground (article playbook #2). What's the pump-fun→pumpswap pattern?
// Also check CUPCAKE: TWO pumpswap pools with DIFFERENT prices for same mint! 0.00001258 vs 0.00004165 (3.3x!)
// That's a REAL same-venue-same-mint cross-pool spread. Pull both pools' addresses:
import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
const cupcake = pools.filter(p => p.name?.startsWith("CUPCAKE"));
for (const p of cupcake) console.log(JSON.stringify(p));
const wofi = pools.filter(p => p.name?.startsWith("WOFI"));
for (const p of wofi) console.log(JSON.stringify(p));
const trump = pools.filter(p => p.name?.startsWith("TRUMPCARD"));
for (const p of trump) console.log(JSON.stringify(p));
