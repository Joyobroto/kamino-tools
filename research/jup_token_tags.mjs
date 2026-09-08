// Better calibration: Jupiter Token API gives verified pools? No — but Jupiter price API can tell us
// which venues are indexable. Instead of guessing pool addresses, fetch Jupiter token list + use
// GeckoTerminal pool data (which includes dex id + addresses). Let's pull a WSOL/USDC pool from Gecko:
const res = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/pools/2J1AMhKHDLjZ4N6CtV4HLoQ2JtDBiorFjRfINGd6hjNg?include=base_token,quote_token,dex", { headers: { Accept: "application/json" } });
// Actually use search endpoint: search pools by SOL/USDC on raydium
const s = await fetch("https://api.geckoterminal.com/api/v2/search/pools?query=SOL%20USDC%20raydium", { headers: { Accept: "application/json" } });
console.log("search status:", s.status);
if (s.ok) {
  const j = await s.json();
  console.log("results:", (j.data ?? []).length);
  for (const p of (j.data ?? []).slice(0, 8)) {
    const a = p.attributes;
    console.log(` ${a.address} | ${a.name} | dex=${p.relationships?.dex?.data?.id} | vol24h=${a.volume_usd?.h24} | liq=$${a.reserve_in_usd}`);
  }
}
