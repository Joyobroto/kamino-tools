// sanctum.xyz blocked. Alternatives:
// 1. Jupiter price API: https://lite-api.jup.ag/price/v3?ids=<mints> — returns USDC price per mint.
//    Rate = price(LST)/price(SOL). Oracle-grade but fine as REFERENCE (market legs measured separately).
// 2. On-chain direct (Jito stake pool accounts) — heavier.
// Test Jupiter price v3 on lite-api:
const LSTS = {
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe",
  JupSOL: "jupSoLaHXQiZZTSfEWMTRRgpF3fZ4NZxXvdLHvGkd87",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcvsLYf",
  bSOL: "bSo13r4TkiE4KumL71LsHTPpX2t7EZ4WH7urYVFIhZ8",
  stSOL: "stk9ApL5He5t5dMM2bzwPsFV3fz7pNKxCHQmvHybDwn",
  INF: "5oVNBeEEQvYi1oX1DhQ3iW9CKQkAQZ2LqeHtXftBr6uz",
  WSOL: "So11111111111111111111111111111111111111112",
};
const ids = Object.values(LSTS).join(",");
const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, { headers: { Accept: "application/json" } });
console.log("jup price v3:", res.status);
if (res.ok) {
  const j = await res.json();
  for (const [sym, mint] of Object.entries(LSTS)) {
    const p = j[mint]?.price ?? j[mint]?.usdPrice;
    console.log(`${sym.padEnd(8)} $${p}`);
  }
  // derive SOL-per-LST:
  const sol = j[LSTS.WSOL]?.price;
  if (sol) {
    console.log("\nSOL-per-LST (reference rates):");
    for (const [sym, mint] of Object.entries(LSTS)) {
      if (sym === "WSOL") continue;
      const p = j[mint]?.price;
      if (p) console.log(`${sym.padEnd(8)} ${(p / sol).toFixed(6)} SOL`);
    }
  }
}
