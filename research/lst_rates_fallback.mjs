// Jupiter price API: LSTs empty. FINAL APPROACH (better anyway — vault truth, no oracle):
// Reference rate per LST = depth-weighted median of LST/SOL pools on our 5 venues.
// We ALREADY have venue layouts + pool listing infra! Plan:
//   1. listProgramAccountsWithData(program, dataSize) → decode mints of ALL pools
//   2. filter pools where (mintA,mintB) == (LST,SOL)
//   3. price each pool from vaults; take the DEEPEST pool's price as reference
//   4. probe LST market executable price via Jupiter (depth-gated)
//   5. spread = reference(deep pool) vs executable(Jup probe)
// The "arb" direction: buy LST cheap where it's listed below the deep-pool rate, sell into the deep pool.
// This is REAL inter-pool arb with vault-truth on both sides — same math as treasure but for LSTs.
console.log("LST reference = deepest pool vault-truth price (oracle-free)");
