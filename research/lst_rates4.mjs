// lite-api price v3 returns empty for LST mints (only WSOL worked?). Maybe wrong param name —
// docs say ?ids=<mint> returns { mint: { usdPrice, blockId, decimals, priceChange? } }.
// Empty {} means: mints not found in their price feed? JitoSOL is major — weird.
// Try api.jup.ag (non-lite) or price/v2:
for (const url of [
  "https://lite-api.jup.ag/price/v3?ids=J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe%2CSo11111111111111111111111111111111111111112",
  "https://lite-api.jup.ag/price/v2?ids=J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe",
]) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  console.log(res.status, url.slice(24, 60), "→", text.slice(0, 300));
}
