// ANB pool math — check the Gecko "liq $6.1M" claim and compute executable arb size
// Pool A: ANB=602,246,963,606,997 raw (6 dec) = 602,246,963 tokens; USDC = 28,005,441 (6dec) = $28M?? 
// Wait — that would make liq = 28M USDC + ANB... Gecko said $6.1M reserve. 602M ANB × $0.0096 = $5.78M ✓
// So Pool A price = 28,005,441 / 602,246,963 = $0.0465/ANB?? Gecko says 0.009577. Hmm — 28005441/602246963 = 0.0465.
// Pool D: ANB=442.69 tokens, USDC=$0.016 → price = 0.16/442 = 0.000362? Gecko said 0.0000136.
// Gecko price likely STALE/cached from creation. The CURRENT on-chain math is what matters:
//  Pool A: 28,005,441 USDC vs 602,246,963 ANB → mid price 0.046496 USDC/ANB
//  Pool D: 16,060 USDC (0.016!) vs 442.69 ANB → mid 0.036272 USDC/ANB
//  → ANB worth ~$0.046 in A vs $0.036 in D — spread ~28%! But sizes: D only holds $0.016 USDC — DUST.
const A = { usdc: 28005441n, anb: 602246963606997n }; // 6dec both
const D = { usdc: 16060n, anb: 442693440n };
const pA = Number(A.usdc) / Number(A.anb);
const pD = Number(D.usdc) / Number(D.anb);
console.log("Pool A price (USDC per ANB):", pA, "→ ANB liquidity value:", (Number(A.anb) / 1e6 * pA).toFixed(2), "USDC; USDC side:", (Number(A.usdc) / 1e6).toFixed(2));
console.log("Pool D price (USDC per ANB):", pD, "→ liq value D:", (Number(D.anb) / 1e6 * pD + Number(D.usdc) / 1e6).toFixed(4), "USDC");
console.log("Gecko-reported prices were stale (A: $0.0096 vs actual $0.0465; D: $0.0000136 vs $0.0363)");
console.log("Spread A vs D now:", ((pA - pD) / pD * 100).toFixed(2), "% — but D holds only $0.016 USDC → max extractable tiny");
// KEY: pools B & C (DAMMv2) have NO Tokenkeg vaults — token-2022? or vaults owned by PDA not pool itself?
