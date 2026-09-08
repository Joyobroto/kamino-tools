// Decisive: quote JupSOL→SOL at increasing sizes + check if bNcdL9Hy85 pool appears in routes.
import { readFileSync } from "node:fs";
const WSOL = "So11111111111111111111111111111111111111112";
const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const sizeLst of [1, 100, 866, 1000]) {
  const params = new URLSearchParams({ inputMint: JUPSOL, outputMint: WSOL, amount: String(sizeLst * 10 ** 9), slippageBps: "1000" });
  const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) { console.log(sizeLst, "JupSOL → NOROUTE"); await sleep(2000); continue; }
  const q = await res.json();
  const solOut = Number(q.outAmount) / 1e9;
  const routes = (q.routePlan ?? []).map(s => `${s.swapInfo?.label}(${s.swapInfo?.ammKey?.slice(0, 8)})`).join(" + ");
  console.log(`sell ${sizeLst} JupSOL → ${solOut.toFixed(4)} SOL (rate ${(solOut / sizeLst).toFixed(4)}) via ${routes} | impact=${q.priceImpactPct}`);
  console.log(`   includes bNcdL9Hy? ${routes.includes("bNcdL9Hy")}`);
  await sleep(2500);
}
// and reverse: buy JupSOL with SOL:
const params = new URLSearchParams({ inputMint: WSOL, outputMint: JUPSOL, amount: String(100 * 10 ** 9), slippageBps: "1000" });
const res2 = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
if (res2.ok) {
  const q2 = await res2.json();
  console.log(`\nbuy with 100 SOL → ${Number(q2.outAmount) / 1e9} JupSOL (rate ${(100 / (Number(q2.outAmount) / 1e9)).toFixed(4)} SOL/JupSOL) via ${(q2.routePlan ?? []).map(s => s.swapInfo?.label).join("+")}`);
}
