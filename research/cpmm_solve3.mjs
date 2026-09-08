// CPMM raw hex: looks like disc(8) then continuous 32-byte fields. Raydium CPMM IDL (public):
// PoolState: authority@8(32), authorityBump@40(1), bumpArray@41(2), token0Vault@43(32), token1Vault@75(32),
// vaultMint? NO — actual: token0Mint? Let's decode with IDL order:
// authority(32)@8, authority_bump(1)@40, bump_seed(2)@41-43, token_0_vault(32)@43, token_1_vault(32)@75,
// vault_signer? hmm... simpler: check offsets 43 and 75 are token accounts on this pool:
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
const key = "JEHPjzMdYPYZuQMhmM26oWE7fi5Emqg5sAN5uVYDAGhU";
const info = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (const off of [43, 75, 107, 139]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`@${off}: ${v.slice(0, 8)} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`@${off}: not token acct`); }
}
