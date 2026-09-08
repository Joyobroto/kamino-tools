// LBUZKh 904B fully verified: mintA@88(WSOL) mintB@120(USDC) vaultA@152(23.9K SOL) vaultB@184(2.6M USDC) ✓
// Now: what IS cpamdpZ? Count its pools + check Gecko label consistency. It matters only for naming.
// From earlier: CPMM-like 1112B pools, mints@168/200, vaults@232/264, vault-owner=PDA(per-mint derived?) NO —
// ANB pool vaults@232/@264 held REAL balances ($0.003 ANB + $8.5 USDC) and were DIRECT token accounts ✓
// Gecko labels cpamdpZ pools as "meteora-damm-v2" → that's what we'll call it (marketing name irrelevant).
// Also verify GIGAANON (LBUZKh) vaults once via its actual pool from gecko_new_pools.json:
import { readFileSync } from "node:fs";
const pools = JSON.parse(readFileSync("research/gecko_new_pools.json", "utf8"));
const gig = pools.filter(p => p.name?.startsWith("GIGAANON") && p.dex === "pumpswap");
console.log(JSON.stringify(gig, null, 1));
