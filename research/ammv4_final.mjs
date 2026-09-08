// AMMv4 vaults aren't owned by the pool — they're owned by the POOL'S PDA authority (shared).
// The vaults in pool data must be at specific offsets. Earlier mint scan found WSOL@400/USDC@432.
// Standard AMMv4 layout (from raydium-amm IDL, widely known):
//   status(6) nonce(1) maxVelo(4) token0Vault(32)@11 token1Vault(32)@43 token0ProgramId(32)@75
//   token1ProgramId(32)@107 token0Mint(32)@139 token1Mint(32)@171 token0Dec(1)@203 token1Dec(1)@204...
// WAIT — that gives mint@139/171, but we found WSOL@400. UNLESS the mints we found at 400/432 are
// actually... the AMM_CONFIG or program IDs? WSOL bytes matched EXACTLY at 400. Hmm.
// Actually official raydium AMM v4 layout:
//   status(6) nonce(1) maxVelo(4) token0Vault@11 token1Vault@43 token0Mint@75 token1Mint@107
//   token0Dec@139 token1Dec@140 vaultSignerNonce@141(8) amtTarget0@149 amtTarget1@157
//   fees@165(40 bytes struct) ... BUT the earlier decode of vaults@11/43 gave nonexistent accounts.
// The REAL v4 layout (checked against actual source now): there are FOUR 32-byte pubkeys at the top:
//   0..5 status, 6 nonce, 7..10 maxVelo, 11..42 token0Vault, 43..74 token1Vault,
//   75..106 token0ProgramId, 107..138 token1ProgramId, 139..170 token0Mint, 171..202 token1Mint...
// The earlier "vault" decode was actually right for offsets but those accounts DIDN'T EXIST →
// because I decoded a DIFFERENT pool (B3c63d...) which is likely dead/closed vaults!
// For the FAMOUS SOL/USDC pool: decode vaults@11/43:
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
const info = await rpcCall("getAccountInfo", ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("vault@11 :", bs58.encode(buf.subarray(11, 43)));
console.log("vault@43 :", bs58.encode(buf.subarray(43, 75)));
console.log("mint@75 :", bs58.encode(buf.subarray(75, 107)));
console.log("mint@107:", bs58.encode(buf.subarray(107, 139)));
for (const [label, off] of [["vault@11", 11], ["vault@43", 43]]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`${label} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`${label} → not token acct`); }
}
// Compare with the REAL vaults found by owner-scan: GzitgXCv (USDC, 13.17M)
