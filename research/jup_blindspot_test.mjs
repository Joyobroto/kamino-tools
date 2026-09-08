// Jupiter blind-spot test on fresh pools:
// WOFI (pumpswap, graduated, liq $196K, mint 8zHUqV2PxzsDj1D8PkL6AX5tYTYSZNWCiKRnpX6Bpump)
// Test 1: can Jupiter quote WSOL→WOFI and back? At what effective price vs pool's own price?
// Test 2: GIGAANON (pumpswap liq$16.5K, mint? — get from new_pools file)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WSOL = "So11111111111111111111111111111111111111112";
const WOFI = "8zHUqV2PxzsDj1D8PkL6AX5tYTYSZNWCiKRnpX6Bpump";
async function quote(inputMint, outputMint, amount) {
  const params = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: "300" });
  const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// $50 of WSOL ≈ 0.25 SOL ≈ 250_000_000 lamports (SOL ~$200 — just a test size)
for (const [label, input, output, amount, inDec, outDec] of [
  ["WSOL→WOFI $50", WSOL, WOFI, "250000000", 9, 6],
]) {
  const q = await quote(input, output, amount);
  if (!q) { console.log(`${label}: NO ROUTE (400)`); continue; }
  const inUi = Number(amount) / 10 ** inDec;
  const outUi = Number(q.outAmount) / 10 ** outDec;
  const effPrice = outUi / inUi; // WOFI per SOL
  const routes = (q.routePlan ?? []).map(s => s.swapInfo?.label).join("→");
  console.log(`${label}: in=${inUi} → out=${outUi.toFixed(2)} WOFI | routes=${routes} | priceImpact=${q.priceImpactPct}`);
  // reverse:
  const back = await quote(output, input, q.outAmount);
  if (!back) { console.log(`  reverse: NO ROUTE`); continue; }
  const backUi = Number(back.outAmount) / 10 ** inDec;
  const roundTripPct = ((backUi - inUi) / inUi * 100).toFixed(3);
  console.log(`  round-trip: ${backUi.toFixed(5)} SOL (${roundTripPct}% vs start)`);
}
