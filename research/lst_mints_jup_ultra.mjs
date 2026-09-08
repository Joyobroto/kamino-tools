// tokens.jup.ag DNS-blocked (same as quote-api.jup.ag was). Try lite-api token list:
for (const url of [
  "https://lite-api.jup.ag/tokens/v1/search?query=JitoSOL",
  "https://lite-api.jup.ag/tokens/v1/search?query=JupSOL",
  "https://lite-api.jup.ag/tokens/v1/search?query=mSOL",
  "https://lite-api.jup.ag/tokens/v1/search?query=bSOL",
  "https://lite-api.jup.ag/tokens/v1/search?query=INF",
]) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) { console.log(url.slice(30, 60), "→", res.status); continue; }
  const tokens = await res.json();
  for (const t of (tokens ?? []).slice(0, 3)) console.log(`${url.slice(45, 65).padEnd(20)} ${t.symbol?.padEnd(9)} ${t.id ?? t.address} ${t.isVerified ? "verified" : ""}`);
  await new Promise(r => setTimeout(r, 1500));
}
