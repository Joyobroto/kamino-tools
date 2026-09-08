// ELUN: dozens of SAME-NAME copycats (pump-fun spam) + one pumpswap pool (DpqTHU4K…) at $0.0000093
// vs pump-fun curves at $0.0000028 — 3.3x. BUT check: same MINT? The pumpswap one likely a different mint that graduated.
// Key check: pool DpqTHU4K's base mint vs pump-fun pools' mints:
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
// get pool details with base_token included
const j = await get("https://api.geckoterminal.com/api/v2/search/pools?query=ELUN");
const pools = j.data ?? [];
const mints = {};
for (const p of pools) {
  // need base token mint — search results don't include relationships; fetch pool by id:
}
// simpler: use the /pools/{id}?include=base_token endpoint for the pumpswap pool + a couple pump-fun pools
for (const pid of ["solana_DpqTHU4KHwqWt1E1M5pfnWUtZV1MAs9fZZ3fdVXaDgjL", "solana_E1PNgiYVcV2UtSoz9AGMbW2ueeqSdZK1xMAkfMbbgsTy"]) {
  const d = await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pid.replace("solana_", "")}?include=base_token,quote_token,dex`);
  const bt = d.included?.find(x => x.type === "token");
  const a = d.data?.attributes ?? {};
  console.log(`${a.name} @ ${d.data?.relationships?.dex?.data?.id}: base mint = ${bt?.id ?? "?"} price=$${Number(a.base_token_price_usd).toPrecision(4)} liq=$${Math.round(Number(a.reserve_in_usd || 0))}`);
  await sleep(3000);
}
