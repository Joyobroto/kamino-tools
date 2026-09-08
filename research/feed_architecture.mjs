// VIABLE NUMBERS for the screener design:
// - Pumpswap: ~200 new pools/hour (582K total). GPA dataSize-diff detection: 2 scans/90s = fine.
// - But the BIG mispricing events are on Meteora DAMMv2 (Eo7WjKq…, space 944) & DBC & Orca.
// Detection cost via GPA-diff: N accounts per scan, dataSlice(0,0) — cheap. 4 venues × 30s cadence OK.
// For each new pool: fetch full account (1 call), decode mints+vaults, fetch vault balances (2 calls),
// price math locally. ~10 RPC calls per new pool × 200/hour = 2000 calls/hour — well within Helius limits.
// THEN the arb check: same mint on another venue with price P2 vs new pool P1 → if P1/P2 > threshold → ALERT + Telegram.
// Optional execute (later, Sprint 2): flashloan WSOL → buy cheap → sell expensive → repay.
console.log("Architecture: GPA-diff pool watcher (4 venues, 30s) → decode → vault-truth pricing → cross-venue compare → Telegram alert.");
