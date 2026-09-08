// EMPIRICAL LAYOUTS DERIVED (owner-scan noise = other pools' vaults sharing authority PDAs — the
// "owned by pool" query actually returns accounts owned by the pool's vault authority PDA, which
// is shared across pools. So vault discovery via owner-scan is UNRELIABLE for these venues.)
// What we CAN rely on:
//  - mint offsets found directly in pool data: DLMM: WSOL@88, USDC@120 → mintA@88, mintB@120; vaultA@152, vaultB@184 (both found in pool data!)
//  - CLMM: WSOL@73, USDC@105 → mintA@73, mintB@105; vaultA@137, vaultB@169 (both in pool data ✓)
//  - Whirlpool: WSOL@101, USDC@181?? Whirlpool layout: tokenA@101? Actually official layout:
//      whirlpools: skip 8 disc, whirlpoolBump@8, tickSpacing... tokenMintA@101? Let me use found offsets:
//      WSOL@101 (mintA), USDC@181?? mintB usually @133... USDC@181 is vault? No — vault found @213 (USDC)
//      and WSOL vault @133. So: mintA@101, mintB@133, vaultA@133?? conflict.
// Official Orca layout: disc(8) whirlpoolBump(1) tickCurrentIndex(4) tickSpacing... tokenVaultA@133, tokenVaultB@165,
//   feeGrowthGlobalA@197... tokenMintA@429, tokenMintB@461.
// But WSOL mint found at @101?? Doesn't match 429. Hmm — 653-byte account though. Maybe our pool is
// on a newer layout. Simplest: DERIVE from data: mintA@101 (WSOL), vaultA@133 (WSOL vault), 
// mintB@181 (USDC), vaultB@213 (USDC vault) — CONSISTENT GAP PATTERN: each pair (mint,vault) 32 bytes apart!
// That means layout: ... mintA@101 mintB@133? no wait. Gap: mint→vault = 32 for both (101→133, 181→213).
// So likely: [something]@69? mintA@101, mintB@133? but then USDC mint@133 would be USDC — we found USDC@181.
// Pattern: mintA@101, vaultA@133, mintB@165?? USDC@181 not 165. vaultB@213.
// Alternative: fields: X@69? mintA@101, ???@133 is vaultA(WSOL), then 165 unused?, mintB@181?? doesn't fit.
// Actually maybe: mintA@101, mintB@133 (WSOL found@101 only means tokenA=WSOL; USDC@181 means tokenB@181?)
// Then: 101+32=133 → vaultA@133 ✓(WSOL vault found there), 181?? but mintB@133 conflicts with vaultA@133.
// Whirlpool official (653 bytes): tokenMintA@429, tokenMintB@461, tokenVaultA@133, tokenVaultB@165.
// USDC@181 ≠ 461. So this account isn't the standard layout?? UNLESS... this "pool" is something else.
// Safest: drop offset-based decode for whirlpool; use official: vaultA@133 vaultB@165 mintA@429 mintB@461
// but VERIFY: is USDC mint at 461? check:
console.log("TODO: verify whirlpool mint@429/461");
