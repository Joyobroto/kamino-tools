// Try the correct Jupiter token API paths:
for (const url of [
  "https://lite-api.jup.ag/tokens/v2/search?query=JitoSOL",
  "https://lite-api.jup.ag/tokens/v2/search?query=mSOL&showAll=false",
  "https://lite-api.jup.ag/token/v2/search?query=bSOL",
]) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) { console.log(res.status, url.slice(30)); continue; }
  const text = await res.text();
  console.log(res.status, url.slice(24, 70), "→", text.slice(0, 250));
  await new Promise(r => setTimeout(r, 1500));
}
