// Find correct program IDs. From the ANB tx earlier: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG" (Phoenix)
// From Gecko dex ids, calibrate actual program ids from known pool owners:
// we know: Meteora DAMMv2 = Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB (from pool owner check)
// Pumpswap? Find from a pumpswap pool account owner: Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N (WOFI pool)
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
for (const [label, addr] of [
  ["WOFI pumpswap pool", "Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N"],
  ["GIGAANON pumpswap pool", "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"],
  ["CUPCAKE pumpswap pool", "EiQuJBjiWY6kY5UYZ1st8KRiCuXHcBtJ1SQRJdUauC7B"],
]) {
  const info = await rpcCall("getAccountInfo", [addr, { encoding: "base64" }]);
  if (!info.value) { console.log(label, "→ gone"); continue; }
  console.log(`${label}: owner=${info.value.owner} space=${Buffer.from(info.value.data[0], "base64").length}`);
}
