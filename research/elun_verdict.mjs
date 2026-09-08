// ELUN verdict: pumpswap ELUN (mint 6HXCCASZ…, graduated, price $0.0093 mcap~$9.3K liq$12K)
// vs pump-fun ELUN (mint EroBxvQm…, DIFFERENT token, price $0.0028) — same NAME different COIN.
// NOT an arb. It's the classic pumpfun copycat-name spam pattern.
// BUT this tells us the real article example: the "hidden treasure" scans compare pools of the SAME mint.
// Our screener MUST: 1) group by exact mint, 2) exclude bonding-curve remnants (pump-fun entries of graduated tokens),
// 3) verify two-sided liquidity on-chain.
console.log("ELUN = name-collision spam, not arb. Screener must group by exact mint + verify 2-sided vaults.");
