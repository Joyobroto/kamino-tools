// Decimal sanity: ANB supply = 9,990,492,739,256,224 raw with 6 decimals = 9.99M tokens total.
// Pool A holds 602,246,963,606,997 raw ANB = 602,246,963 tokens?? That's 60x total supply! IMPOSSIBLE.
// → ANB is probably 9 decimals, not 6. Then supply = 9.99B tokens, pool A holds 602.2M ANB.
// Gecko pool "liq $6.1M": 602M ANB × price 0.0096 = $5.78M + USDC? USDC raw 28,005,441 @6dec = $28M?? 
// Gecko $6.1M ≈ 5.78M + 0.28M? Doesn't add. Let's check decimals on-chain properly via getAccountInfo on mint.
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const mintInfo = await rpcCall("getAccountInfo", ["FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj", { encoding: "jsonParsed" }]);
const mp = mintInfo.value.data.parsed.info;
console.log("ANB decimals:", mp.decimals, "supply:", mp.supply);
// Also fetch info of vaults we found for the amount/decimals sanity:
// Pool A USDC vault = first USDC result. Its uiAmount:
