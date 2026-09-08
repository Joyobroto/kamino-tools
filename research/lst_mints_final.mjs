// tokens/v2/search works! Get canonical mints for all registry LSTs:
const SYMBOLS = ["JitoSOL", "JupSOL", "mSOL", "bSOL", "stSOL", "INF"];
const found = {};
for (const sym of SYMBOLS) {
  const url = `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(sym)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) { console.log(sym, "→", res.status); await new Promise(r => setTimeout(r, 1500)); continue; }
  const tokens = await res.json();
  // prefer verified / exact symbol match
  const exact = (tokens ?? []).filter(t => t.symbol?.toUpperCase() === sym.toUpperCase());
  const pick = exact[0] ?? (tokens ?? [])[0];
  if (pick) console.log(`${sym.padEnd(9)} ${pick.id} "${pick.name}" ${pick.isVerified ? "verified" : "unverified"}`);
  await new Promise(r => setTimeout(r, 1200));
}
