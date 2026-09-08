// Jupiter ref routes via "Meteora DAMM v2" pool AWRUuF…, NOT our pumpswap pool. So a second
// market EXISTS. But the quote outputs look TINY: 100M base → 0.000119 SOL?? That means the
// DAMMv2 pool holds dust. priceImpact=0 because the quote is trivially small.
// CHECK: what is pool AWRUuFUh...? Get its vault balances:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
// find the full pool address via Jupiter route ammKey — I only have 8 chars. Get full via fresh quote:
const params = new URLSearchParams({ inputMint: "2wyJSu4aFoygovnN4b2me1km6U3RKWucPTwFV9wzEsXZ", outputMint: "So11111111111111111111111111111111111111112", amount: "1000000", slippageBps: "3000" });
const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } })).json();
const ammKey = q.routePlan[0].swapInfo.ammKey;
console.log("Jupiter ref pool (full):", ammKey);
const info = await call("getAccountInfo", [ammKey, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("owner:", info.value.owner, "size:", buf.length);
// if it's cpamdpZ 1112B: mints@168/200, vaults@232/264
const mintA = bs58.encode(buf.subarray(168, 200));
const mintB = bs58.encode(buf.subarray(200, 232));
console.log("mintA:", mintA.slice(0, 10), "mintB:", mintB.slice(0, 10));
const vA = bs58.encode(buf.subarray(232, 264));
const vB = bs58.encode(buf.subarray(264, 296));
for (const [label, v] of [["vaultA", vA], ["vaultB", vB]]) {
  const bal = await call("getTokenAccountBalance", [v]);
  console.log(label, bal.value.uiAmountString, `(${bal.value.decimals}dec)`);
}
