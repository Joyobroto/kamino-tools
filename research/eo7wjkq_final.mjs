// Hmm — mint@8 = 8fL5oNPF... but vault@168's mint = FZN7QZ8Z... ≠ mint@8. And vault@200 mint ≠ WSOL.
// So the pool @168/@200 vaults belong to a DIFFERENT pool sharing the vault-authority PDA owner
// (same phenomenon as before: "token accounts owned by pool" via owner-scan is unreliable).
// BUT the getTokenAccountBalance approach (which worked earlier) verified these as REAL token accounts
// with balances that make sense for JitoSOL/SOL pool (10.5K jito + 11.4K SOL = $6.9M liq ✓ matches Gecko $6.9M!)
// Wait — that data came from THIS pool ERgpKaq59. The mint mismatch means @168/@200 are token accounts
// but belong to other pools? Balances 10524/11469 exactly matching a big JitoSOL/SOL pool is suspicious-good.
// Check the vault OWNER of @168:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const POOL = "ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw";
const info = await rpcCall("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (const off of [168, 200]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  const ai = await rpcCall("getAccountInfo", [v, { encoding: "jsonParsed" }]);
  const p = ai.value?.data?.parsed?.info;
  console.log(`vault@${off} ${v.slice(0, 10)} mint=${p?.mint} owner=${p?.owner}`);
}
console.log("pool:", POOL);
