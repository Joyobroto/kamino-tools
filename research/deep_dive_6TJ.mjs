// Deepest candidate: 6TJ6JB7k (20.7% disc, 987M base + 152 SOL, ref 1.94e-7 exists)
// iRVvXFbX (69% disc), 9mYtoY66 (46.5%), AJkVALCw (52.5%)
// Question: is the REF for these REAL (depth > $500) or another dust pool?
// Method: quote a $500-size SELL of the base mint via Jupiter and check price impact + route.
import { readFileSync } from "node:fs";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WSOL = "So11111111111111111111111111111111111111112";
const mints = [
  ["6TJ6JB7k (20.7%)", null, 6], // fill from events
];
const events = JSON.parse(readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n")[22]);
// find by 8-char prefix in all events:
const all = readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const targets = [
  all.find(e => e.baseMint.startsWith("6TJ6JB7k")),
  all.find(e => e.baseMint.startsWith("iRVvXFbX")),
  all.find(e => e.baseMint.startsWith("9mYtoY66")),
  all.find(e => e.baseMint.startsWith("AJkVALCw")),
].filter(Boolean);
console.log("targets:", targets.map(t => t.baseMint.slice(0, 8)));
for (const t of targets) {
  // $500 ≈ 2.5 SOL worth. Pool price: base per SOL = 1/poolPriceInSol.
  const basePerSol = 1 / t.poolPriceInSol;
  const sizeBase = Math.round(2.5 * basePerSol); // sell $500 worth
  const params = new URLSearchParams({ inputMint: t.baseMint, outputMint: WSOL, amount: String(sizeBase), slippageBps: "5000" });
  let q = null;
  for (let a = 0; a < 3; a++) {
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
    if (res.status === 400) { q = "NOROUTE"; break; }
    if (res.status === 429) { await sleep(5000); continue; }
    if (res.ok) { q = await res.json(); break; }
  }
  if (q === "NOROUTE") { console.log(`${t.baseMint.slice(0, 8)}: NO ROUTE for $500 size`); await sleep(2000); continue; }
  if (!q) { console.log(`${t.baseMint.slice(0, 8)}: quote failed`); await sleep(2000); continue; }
  const out = Number(q.outAmount) / 1e9;
  const routes = (q.routePlan ?? []).map(s => s.swapInfo?.label).join("+");
  // compare: we expect ~2.5 SOL at ref price; actual:
  console.log(`${t.baseMint.slice(0, 8)} (disc ${(1 - t.ratio).toFixed(3)}): selling ${sizeBase.toExponential(2)} base (≈$500 at pool price) → ${out.toFixed(3)} SOL | impact=${q.priceImpactPct} | via ${routes}`);
  await sleep(2500);
}
