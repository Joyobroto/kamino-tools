// DECISIVE: is Jupiter's "reference price" for these mints deep enough to absorb 1.3e8 base?
// If Jupiter's best route for selling that size IS the same pool → circular, no arb.
// Test with the FRen3yHG mint (2wyJSu4a...) — get full mint from an event + quote a BIG sell.
import { readFileSync } from "node:fs";
const events = JSON.parse(readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n")[0]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BASE = events.baseMint;
const WSOL = "So11111111111111111111111111111111111111112";
async function quote(input, output, amount) {
  const params = new URLSearchParams({ inputMint: input, outputMint: output, amount, slippageBps: "3000" });
  const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) return null;
  if (!res.ok) return null;
  return res.json();
}
console.log("mint:", BASE);
// small quote: 1 base unit (probe decimals=6 assumed) → derive price + route
const small = await quote(BASE, WSOL, "1000000");
if (small) {
  console.log("\n1M base → SOL:", Number(small.outAmount) / 1e9, "SOL; routes:", (small.routePlan ?? []).map(s => s.swapInfo?.label + ":" + s.swapInfo?.ammKey?.slice(0, 6)).join(", "));
  console.log("price impact:", small.priceImpactPct);
}
await sleep(1500);
// the pool address from the event — is it in Jupiter's route?
console.log("\nevent pool:", events.poolAddress);
// medium: 10M base
const med = await quote(BASE, WSOL, "10000000");
if (med) {
  console.log("\n10M base → SOL:", Number(med.outAmount) / 1e9, "SOL; routes:", (med.routePlan ?? []).map(s => s.swapInfo?.label).join(", "));
  console.log("price impact:", med.priceImpactPct);
}
await sleep(1500);
// LARGE: half the pool's base inventory (1e8)
const big = await quote(BASE, WSOL, "100000000");
if (big) {
  console.log("\n100M base → SOL:", Number(big.outAmount) / 1e9, "SOL; priceImpact:", big.priceImpactPct);
  const routes = (big.routePlan ?? []).map(s => `${s.swapInfo?.label}(${s.swapInfo?.ammKey?.slice(0, 8)})`);
  console.log("routes:", routes.join(" → "));
  console.log("event pool in route?", routes.some(r => r.includes(events.poolAddress.slice(0, 8))));
} else console.log("\n100M base: NO ROUTE / too large");
