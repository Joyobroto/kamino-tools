// Jupiter CAN route WOFI via Pump.fun Amm — round-trip cost 1.15% (spread+fees+slippage).
// Not blind to fresh pumpswap pools. Now test the REAL blind-spot claim: unindexed/stale pools.
// The claim in the article: pools with jomplang ratios that Jupiter can't route optimally.
// Best test available: the DAMMv2 ANB pool with $240K claimed — but we proved it's a grave.
// More useful: test whether Jupiter finds the BEST pool among multiple for the same mint.
// CUPCAKE has 3 pumpswap pools (different mints, spam). Skip.
// DECISIVE TEST: take a mint with TWO REAL pools (Meteora SOL/USDC vs Raydium SOL/USDC vs Orca) — majors —
// and see if Jupiter's routing matches. We already know it does (arb-scan showed 0-0.5bps).
// FINAL ANSWER for blind-spot: Jupiter indexes majors + fresh pumpswap fine.
// The ONLY pools Jupiter misses: DBC (dynamic bonding curve), dead pools, private/intent venues.
// Test one DBC pool (meteora-dbc appeared in new pools, e.g. wheelsmith/Anthropic):
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
// find pools where the SAME mint has both a pumpswap/dammv2 pool AND a meteora-dbc pool:
const byMint = {};
for (const p of pools) if (p.baseMint) (byMint[p.baseMint] ??= []).push(p);
let tested = 0;
for (const [mint, list] of Object.entries(byMint)) {
  const hasDbc = list.some(p => p.dex === "meteora-dbc");
  const hasReal = list.some(p => p.dex && p.dex !== "meteora-dbc" && (p.liqUsd ?? 0) > 1000);
  if (hasDbc && hasReal && tested < 3) {
    tested++;
    const mintAddr = mint.replace("solana_", "");
    console.log(`\nmint ${mintAddr.slice(0, 12)}… pools:`);
    for (const p of list) console.log(`   ${p.dex} price=$${p.price.toPrecision(3)} liq=$${Math.round(p.liqUsd)}`);
    // does Jupiter quote it?
    const params = new URLSearchParams({ inputMint: "So11111111111111111111111111111111111111112", outputMint: mintAddr, amount: "50000000", slippageBps: "1000" });
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
    if (res.status === 400) console.log("  Jup: NO ROUTE");
    else if (res.ok) {
      const q = await res.json();
      const routes = (q.routePlan ?? []).map(s => s.swapInfo?.label).join("→");
      console.log(`  Jup: ROUTED via ${routes}`);
    } else console.log("  Jup: HTTP", res.status);
    await sleep(1500);
  }
}
if (!tested) console.log("no same-mint dbc+real pairs found in new pools sample");
