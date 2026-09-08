// 200 pumpswap sigs span ONE SECOND (13:34:31→13:34:32) — pumpswap is hyperactive (migration + swaps).
// 28/30 sampled are "create"-flagged but that includes pumpfun MIGRATIONS (create pool event per migration).
// Real signal: detect via program log "Instruction: CreatePool" discriminator or new 301-byte accounts.
// The creation rate is TOO HIGH for manual, PERFECT for a bot. Volume estimate:
// Gecko showed ~200 new pools in newest pages (mixed venues). Pump.fun launches ≈ thousands/day.
// Realistic filter funnel: new pool → SAME mint exists elsewhere with real price → ratio mismatch > X% → alert.
console.log("Feed viable: getSignaturesForAddress on pool programs (pumpswap/meteora/raydium) + filter creates.");
