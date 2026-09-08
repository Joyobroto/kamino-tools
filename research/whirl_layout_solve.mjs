// Whirlpool empirical solve:
// mintA@101 = WSOL, vaultA@133 = 114,052 SOL ✓
// mintB@181 = USDC, vaultB@213 = 14.1M USDC ✓
// offset pattern: mintA@101, mintB@133?? NO — vaultA@133. So mintB is NOT at 133.
// Real pattern: mintA@101, vaultA@133 (gap 32), mintB@181, vaultB@213 (gap 32).
// What's between 165-181? feeGrowth u128s. Layout: ..., tokenMintA@101, tokenVaultA@133,
// feeGrowthGlobalA@165(16), feeGrowthGlobalB@181? NO mintB@181.
// FINAL: mintA=101, vaultA=133, mintB=181, vaultB=213 (all confirmed with live balances)
console.log("whirlpool: mintA@101 vaultA@133 mintB@181 vaultB@213 ✓");
// Now CPMM (637 bytes): grab one and solve the same way:
