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
const info = await rpcCall("getAccountInfo", ["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (const [off, label] of [[101, "field@101"], [133, "vaultA?"], [165, "vaultB?"], [181, "USDC-mint?"], [213, "USDC-vault?"], [429, "mintA-official?"], [461, "mintB-official?"]]) {
  console.log(label, "→", bs58.encode(buf.subarray(off, off + 32)).slice(0, 12) + "…");
}
// vault balances at 133/165:
for (const off of [133, 165, 213]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`@${off} balance: ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`@${off}: not token acct`); }
}
