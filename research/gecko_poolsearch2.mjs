// GeckoTerminal search: try different queries
const queries = ["SOL/USDC", "SOL USDC", "WSOL/USDC", "JitoSOL SOL"];
for (const q of queries) {
  const s = await fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
  if (!s.ok) { console.log(q, "status", s.status); await new Promise(r => setTimeout(r, 3000)); continue; }
  const j = await s.json();
  const pools = j.data ?? [];
  console.log(`\nquery="${q}" → ${pools.length} results`);
  for (const p of pools.slice(0, 5)) {
    const a = p.attributes;
    console.log(`  ${a.address} | ${a.name} | dex=${p.relationships?.dex?.data?.id} | liq=$${Math.round(Number(a.reserve_in_usd || 0))} | vol24h=$${Math.round(Number(a.volume_usd?.h24 || 0))}`);
  }
  await new Promise(r => setTimeout(r, 3000));
}
