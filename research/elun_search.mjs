// Elun was mentioned in the user's message (article images). Search Gecko for ELUN pools + any token named Elun:
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
// search tokens by name
for (const q of ["ELUN", "elun"]) {
  try {
    const j = await get(`https://api.geckoterminal.com/api/v2/search/tokens?query=${encodeURIComponent(q)}`);
    const tokens = j.data ?? [];
    console.log(`token search "${q}":`, tokens.length);
    for (const t of tokens.slice(0, 10)) {
      const a = t.attributes;
      console.log(`  ${t.id.replace("solana_", "").slice(0, 8)}… ${a.symbol} "${a.name}" price=$${a.price_usd} coingeckoId=${a.coingecko_coin_id ?? "-"}`);
    }
  } catch (e) { console.log(q, "ERR", e.message.slice(0, 60)); }
  await sleep(3000);
}
