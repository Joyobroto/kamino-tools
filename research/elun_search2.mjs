// search/tokens 404 — correct endpoint is /search?query=
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
const j = await get("https://api.geckoterminal.com/api/v2/search?query=ELUN&include=network");
console.log("categories:", (j.data ?? []).length);
for (const item of (j.data ?? []).slice(0, 10)) {
  const a = item.attributes ?? {};
  console.log(` ${item.type} | ${a.address ?? ""} | ${a.name ?? ""} ${a.symbol ?? ""}`);
}
