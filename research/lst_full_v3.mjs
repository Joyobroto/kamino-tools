// Registry mints VALIDATED (100+ pools each hold them on Orca alone).
// The earlier memcmp mystery is SOLVED conceptually: Helius memcmp only matches ≤ 43-char base58
// (some indexer limit); our LST mints are 43-44 chars. So the scanner's memcmp approach in
// findLstPools will miss long mints! The dataSlice+local-filter method works.
// Quick smoke: run one full lst-scan with corrected registry and see sane spreads now:
console.log("re-run npm cli lst-scan");
