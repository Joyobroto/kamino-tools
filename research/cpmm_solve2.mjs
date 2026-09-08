// CPMM: 230K accounts of size 637 — that count INCLUDES positions? No position in CPMM is different size.
// Loop didn't print a "pool:" line → none of the first 5 had 2+ token-account candidates. Show raw first:
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
const res = await rpcCall("getProgramAccounts", ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", {
  encoding: "base64", filters: [{ dataSize: 637 }], dataSlice: { offset: 0, length: 0 }, withContext: false,
}]);
const key = res[0].pubkey;
const info = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (let i = 0; i < 256; i += 32) console.log(String(i).padStart(3), buf.subarray(i, i + 32).toString("hex").slice(0, 60));
console.log("key:", key);
