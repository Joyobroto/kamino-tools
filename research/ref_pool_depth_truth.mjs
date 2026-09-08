// ALL four "deep discount" candidates: Jupiter sell of $500-size returns ~0 SOL
// → the reference market is DUST for every one of them. The 20-70% discounts are mirages:
// second market holds < $1 of liquidity.
// FINAL VERIFICATION — how big IS the real ref depth? Try $50 / $10 / $1 sell sizes:
import { readFileSync } from "node:fs";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WSOL = "So11111111111111111111111111111111111111112";
const all = readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const t = all.find(e => e.baseMint.startsWith("6TJ6JB7k"));
const basePerSol = 1 / t.poolPriceInSol;
for (const usd of [50, 10, 1]) {
  const sizeBase = Math.round((usd / 200) * basePerSol);
  const params = new URLSearchParams({ inputMint: t.baseMint, outputMint: WSOL, amount: String(sizeBase), slippageBps: "10000" });
  const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) { console.log(`\$${usd}: NO ROUTE`); await sleep(2000); continue; }
  const q = await res.json();
  const out = Number(q.outAmount) / 1e9;
  console.log(`sell $${usd} worth (${sizeBase} base) → ${out.toFixed(6)} SOL (${(out * 200).toFixed(2)} USD) | routes: ${(q.routePlan ?? []).map(s => s.swapInfo?.label).join("+")}`);
  await sleep(2500);
}
