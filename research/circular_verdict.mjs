// SMOKING GUN for the "42 SOL profit" fantasy:
// Jupiter's "reference" for mint 2wyJSu4a is a cpamdpZ DAMMv2 pool with:
//   vaultA = 1,886 base tokens (6dec) + vaultB = 0.0024 SOL — TOTAL GARBAGE POOL ($0.5)
// The 1M-base quote (0.000001256 SOL) is a dust pool with zero depth.
// Our "8% discount vs Jupiter" = pumpswap pool (real, $30K) vs a DUST pool (worthless price).
// The 'reference price' from Jupiter has NO DEPTH for these mints → the 42-SOL theoretical
// profit is FICTION. Buying 93 SOL worth in pumpswap and selling into ref = impossible.
// BUT the events are still real discounts vs *some* second market — question is which second
// market has real depth: for pumpfun migrations it's the BONDING CURVE remnants (dust) or
// OTHER new pools. Essentially: single-venue listing = no executable arb.
// CONCLUSION: measurement isn't wrong per se — it measures pool-vs-Jupiter-best-dust.
// For EXECUTION we need: reference depth check (min size quote, e.g. $500 sell must not
// move > 2%), not just a 1-unit price.
console.log("VERDICT: ref-depth gate missing. 42-SOL profits are dust-pool mirages. Need depth-validated reference.");
