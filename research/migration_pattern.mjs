// CRITICAL INSIGHT from data: "CUPCAKE" appears as 5 DIFFERENT MINTS (same name, different contracts!)
// — pumpfun copycat spam. Name-based grouping is WRONG; mint-based is right.
// The pump-fun vs pumpswap rows with the SAME mint (WOFI: 8zHUqV2...pump) show price 0.0000110 (pump-fun)
// vs 0.005421 (pumpswap) — 490x! But pump-fun liq=$0 → it's the bonding-curve REMNANT after migration.
// The $696K ANB arb (May 1) was exactly this class: migration mispricing.
// KEY QUESTION: can we detect a migration LISTING at a wrong price? At migration, pumpfun moves the curve
// to pumpswap automatically — price is continuous. The BIG mispricings come from NEW liq added at wrong ratio
// (article's "0.006 Jesus + 0.2 sol" example) or a SECOND pool someone creates.
// What we CAN scan: pumpfun migration events + new pumpswap/meteora pools, then compare price vs
// other venues for the SAME mint at the moment of detection.
console.log("Pattern confirmed: same-name different-mint spam (CUPCAKE x5 mints). Must group by MINT.");
console.log("WOFI mint 8zHUqV2...pump: pumpswap real price $0.0054 (liq$196K) vs pump-fun remnant $0.000011 (dead, liq$0)");
console.log("→ the '490x spread' is a dead bonding curve remnant — not tradable.");
console.log("TRUMPCARD same story. GIGAANON same.");
