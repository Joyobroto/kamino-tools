// SOLVED: Gecko's "meteora-damm-v2" label = program cpamdpZ (1112-byte pools, mints@168/200, vaults@232/264
// — the layout I verified on the ANB pool with live balances $0.003/$8.5!).
// Eo7WjKq (944B, mints@8/@40) is a DIFFERENT program (maybe Meteora DLMM variant / Infinity?).
// And LBUZKh (904B) = "meteora" label with 156K pools (that's the actual DAMMv1/v2 we saw as "meteora" SOL/USDC 904B!).
// CONCLUSION for venues.ts:
//   - "meteora-damm-v2" (Gecko label) → program cpamdpZ, 1112B, mints@168/200, vaults@232/264 ✓ VERIFIED
//   - Eo7WjKq 944B: mints@8/@40 ✓, vaults PDA-derived → needs off-chain PDA derive; 16K pools
//   - LBUZKh 904B: 156K pools — the "meteora" (DAMMv1?) label. Earlier: GIGAANON pool owner=LBUZKh 904B with
//     vault offsets…? We never verified 904B vault offsets! Only mints @? — the SOL/USDC pool 5rCf1DM8 showed
//     WSOL@88, USDC@120, vaults @152/@184 FOUND IN POOL DATA with balances 22.5M SOL? wait that was
//     amount 22,527,767,082,342 raw 9dec = 22,527 SOL — that's the SOL/USDC pool liq ✓.
//     So LBUZKh 904B: mintA@88, mintB@120, vaultA@152, vaultB@184 — VERIFIED earlier ✓
console.log("DAMMv2 truth established:");
console.log("- cpamdpZ 1112B (Gecko 'meteora-damm-v2'): mints@168/200, vaults@232/264 ✓");
console.log("- LBUZKh 904B (Gecko 'meteora'/DAMMv1?): mints@88/120, vaults@152/184 ✓");
console.log("- Eo7WjKq 944B: mints@8/40 ✓, vaults PDA-derived (exclude or derive)");
