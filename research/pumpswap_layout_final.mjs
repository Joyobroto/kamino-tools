// pumpswap pool: only ONE vault owned by pool (WSOL, @171). The WOFI vault is owned by a PDA authority, not the pool.
// pumpswap layout (from hex): disc f19a6d04(4) ... poolBump? @4-5 ...
// offset 0..42: disc(8) + config(32)? then creator?(32)...
// EMPIRICAL FINAL: mintA@43, mintB@75, WSOL vault@171 (found). The other vault (WOFI) is likely @139:
// hexdump shows 9cd76b39b4ef1b69... at 32-63 (config/creator), 64-95 = c22e2722...(pool authority?)
// 96..107: eb3b5598a0 (end of field@64..96+11?) then @107: 1d7b9de34e32884e (start of 32B) → vault?
// Test: is @107 a token account? Check via getAccountInfo:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
import bs58 from "bs58";
const info = await rpcCall("getAccountInfo", ["Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (const off of [107, 139, 171, 203]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`@${off}: ${v} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`@${off}: ${v} → not a token acct`); }
}
