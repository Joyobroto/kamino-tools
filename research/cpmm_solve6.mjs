// CPMM candidate: vaults @64 (9dec, dust) and @96 (6dec, $27.8K) — pool with ~$27.8K one side.
// @128/@160/@192 errors = likely Token2022 accounts or closed. Mints should be at vault-32-8? 
// Standard CPMM IDL: authority@8, authorityBump@40, bumps@41-42, token0Vault@64, token1Vault@96,
// vault0Mint? Actually next fields: token0Mint@? Let's assume mints right after vaults: @128/@160 failed
// as token accounts — could be mints! Mint accounts are owned by TOKEN PROGRAM too... they errored on
// getTokenAccountBalance because they're MINTS not accounts. getMultipleAccounts said 128/160/192 ARE
// owned by Token Program → they're mints! Verify mint@128 & mint@160:
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
for (const off of [128, 160, 192]) {
  const m = bs58.encode(buf.subarray(off, off + 32));
  const minfo = await rpcCall("getAccountInfo", [m, { encoding: "jsonParsed" }]);
  const p = minfo.value?.data?.parsed?.info;
  console.log(`@${off}: ${m.slice(0, 10)}… decimals=${p?.decimals} supply=${p?.supply} mintAuth=${!!p?.mintAuthority} freezeAuth=${!!p?.freezeAuthority}`);
}
// And check if 192 is LP mint (supply>0, mint authority = pool)
