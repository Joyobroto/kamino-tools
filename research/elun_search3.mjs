// Try search/pools with ELUN query (this endpoint worked earlier for "SOL/USDC")
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
const j = await get("https://api.geckoterminal.com/api/v2/search/pools?query=ELUN");
const pools = j.data ?? [];
console.log("ELUN pools:", pools.length);
for (const p of pools.slice(0, 15)) {
  const a = p.attributes;
  console.log(`  ${a.address} | ${a.name} | dex=${p.relationships?.dex?.data?.id} | price=$${Number(a.base_token_price_usd).toPrecision(4)} | liq=$${Math.round(Number(a.reserve_in_usd || 0))} | vol24h=$${Math.round(Number(a.volume_usd?.h24 || 0))}`);
}
