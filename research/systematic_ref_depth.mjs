// Systematic: run the reference-depth check across ALL 46 events (cheap: 1 Jupiter quote each).
// Gate: sell $100 worth of base via Jupiter → require ≥ $80 back (20% slippage tolerance).
import { readFileSync } from "node:fs";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WSOL = "So11111111111111111111111111111111111111112";
const all = readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const results = [];
for (let i = 0; i < all.length; i++) {
  const e = all[i];
  if (!e.referencePriceInSol) { results.push({ mint: e.baseMint.slice(0, 8), pass: false, why: "no-ref" }); continue; }
  const basePerSol = 1 / e.poolPriceInSol;
  const sizeBase = Math.round((100 / 200) * basePerSol); // $100 at pool price
  const params = new URLSearchParams({ inputMint: e.baseMint, outputMint: WSOL, amount: String(Math.max(sizeBase, 1)), slippageBps: "2000" });
  let q = null;
  for (let a = 0; a < 3; a++) {
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
    if (res.status === 400) { q = "NOROUTE"; break; }
    if (res.status === 429) { await sleep(4000); continue; }
    if (res.ok) { q = await res.json(); break; }
  }
  if (q === "NOROUTE") { results.push({ mint: e.baseMint.slice(0, 8), pass: false, why: "no-route@$100" }); continue; }
  if (!q) { results.push({ mint: e.baseMint.slice(0, 8), pass: false, why: "quote-fail" }); continue; }
  const outUsd = (Number(q.outAmount) / 1e9) * 200;
  results.push({ mint: e.baseMint.slice(0, 8), pass: outUsd >= 80, outUsd: outUsd.toFixed(2), disc: ((1 - e.ratio) * 100).toFixed(1) + "%" });
  await sleep(1200);
}
const passing = results.filter(r => r.pass);
console.log(`\n${passing.length}/${results.length} events pass the $100-sell depth gate`);
for (const r of passing) console.log("  PASS:", JSON.stringify(r));
const reasons = {};
for (const r of results.filter(r => !r.pass)) reasons[r.why] = (reasons[r.why] ?? 0) + 1;
console.log("failure reasons:", JSON.stringify(reasons));
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/opencode/ref_depth_results.json", JSON.stringify(results, null, 1));
