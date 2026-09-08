// Listing ordered & stable (pubkey ascending: 114… < 118… < 11A…). 
// KEY INSIGHT: if ordering is by pubkey (deterministic), a "tail page" trick won't find new pools
// (new pubkeys scatter across the space). BUT stability means we can hash-compare pages cheaply?
// No — simpler: the DIFF itself is fine; the issue is only BANDWIDTH (83s for cpamdpZ).
// FINAL DESIGN DECISION (pragmatic):
//   1. Keep V2 pagination diff for: pumpswap, meteora-damm, raydium-clmm, orca (~100s total)
//   2. cpamdpZ (1.45M): move to SLOWER cadence (its own loop, every ~10 min) — new-pool volume there
//      is launchpad spam; missing a few minutes of cpamdpZ listings costs nothing.
//   3. Watch interval: recommend 120s (full cycle ~100s + slack).
// Implement: PoolFeed.scan() accepts venue subsets; the scanner runs two loops.
console.log("design: split cadence — main venues every pass, cpamdpZ every Nth pass");
