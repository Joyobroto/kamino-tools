// Vaults @168 (10,524 jitoSOL) and @200 (11,469 SOL) confirmed! JitoSOL mint not found by scan?
// The scan printed nothing for JitoSOL mint — maybe I mised. WSOL@40 though. So layout: mintA@8, mintB@40? vaultA@168, vaultB@200.
// Verify: mint@8 should be JitoSOL:
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
console.log("mint@8 :", bs58.encode(buf.subarray(8, 40)));
console.log("mint@40:", bs58.encode(buf.subarray(40, 72)));
// and vault mints for @168/@200:
for (const off of [168, 200]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  const info2 = await rpcCall("getAccountInfo", [v, { encoding: "jsonParsed" }]);
  const p = info2.value?.data?.parsed?.info;
  console.log(`vault@${off} mint:`, p?.mint?.slice(0, 12), "amount:", p?.tokenAmount?.uiAmountString);
}
