// BIZARRE: memcmp@181+WSOL works (1070 pools) but memcmp@181+JitoSOL=0 & memcmp@101+JitoSOL=0.
// Both offsets work with WSOL. So offsets are fine — the INDEX misses JitoSOL mints specifically?!
// Hypothesis: Helius pre-indexes memcmp only for POPULAR values? No... OR the JitoSOL pools
// actually have JitoSOL at a DIFFERENT offset and the Hp53XEtt decode I read was offset-shifted?
// Recheck: does Hp53XEtt really contain JitoSOL bytes at 181? YES — verified: field@181=J1toso1uCk.
// Test membership directly: is Hp53XEtt in the r1 result above (if JitoSOL@101)?
// New hypothesis: Helius memcmp requires... base58 vs base64 encoding of 'bytes'!
// WSOL starts 'So111...' — in base58, many leading zeros encode as '1's. WSOL = 32 bytes with
// leading zero bytes (0x00...00 02). base58 'So11...' vs JitoSOL normal key.
// MAYBE the Helius indexer only indexes memcmp for offsets ≤ some value... but 181+WSOL worked.
// Try: getProgramAccounts on the WHIRL program with memcmp on a different LST (mSOL):
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
for (const [name, mint] of [
  ["mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcvsLYf"],
  ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
]) {
  for (const off of [101, 181]) {
    const r = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: off, bytes: mint } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
    console.log(`${name}@${off}:`, r.length);
  }
}
