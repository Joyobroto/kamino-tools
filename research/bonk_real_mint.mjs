// My from-memory BONK mint was WRONG (same trap as JitoSOL before!). Get real mints from
// Jupiter token search (like we did for LSTs):
for (const sym of ["BONK", "WIF", "POPCAT"]) {
  const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${sym}`, { headers: { Accept: "application/json" } });
  if (!res.ok) { console.log(sym, res.status); continue; }
  const tokens = await res.json();
  const exact = (tokens ?? []).filter(t => t.symbol?.toUpperCase() === sym && t.isVerified);
  for (const t of exact.slice(0, 1)) console.log(`${t.symbol.padEnd(8)} ${t.id} "${t.name}" verified`);
  await new Promise(r => setTimeout(r, 1200));
}
