// Jupiter blind-spot FINAL verdict from tests:
// 1. Fresh pumpswap pools (WOFI, GIGAANON): Jupiter routes them FINE (via "Pump.fun Amm" label)
// 2. Even dust DAMMv2 pools: routed (Meteora DAMM v2 label)
// 3. DBC pools: not directly routed but their liquidity is $0-2 anyway
// CONCLUSION: the "Jupiter is blind" claim from the article is only true for:
//   - pools so new that indexing lags (minutes)
//   - DBC / non-standard pool types
//   - CUSTOM routing (Jupiter picks best pool; it won't show you the spread itself)
// The REAL edge isn't "Jupiter can't see the pool" — it's "nobody is watching these mints".
// The arb exists in the WINDOW between pool creation/mispricing and someone acting.
console.log("VERDICT: Jupiter routes even dust pools. The edge is SPEED of DETECTION on new/mispriced pools, not Jupiter blindness.");
console.log("The article's real playbook #2 (new liquidity) = detect new pool with wrong ratio → execute.");
console.log("Playbook #1 (hidden treasure) = stale mispriced pools where spread persists (rare, mostly graves).");
