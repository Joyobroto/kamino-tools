// Rate-limited death spiral. FASTER approach: skip Gecko. Get mints from Jupiter's token list
// (tokens.jup.ag) which has canonical LST addresses:
const res = await fetch("https://tokens.jup.ag/tokens?tags=lst", { headers: { Accept: "application/json" } });
console.log("jup lst tokens:", res.status);
if (res.ok) {
  const tokens = await res.json();
  console.log("count:", tokens.length);
  for (const t of tokens.slice(0, 25)) {
    console.log(`${(t.symbol ?? "?").padEnd(10)} ${t.address}${t.isVerified ? " ✓" : ""}`);
  }
}
