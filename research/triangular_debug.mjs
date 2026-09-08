// Debug: why 0 BONK pools? The meteora-damm listing is 156K pools across 16 pages — maybe the
// dataSlice offsets hit mints fine; suspect: BONK mint address wrong. Verify BONK mint:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCaBRiWmHQxjC4tDgWi";
const info = await call("getAccountInfo", [BONK, { encoding: "jsonParsed" }]);
console.log("BONK mint exists:", !!info.value, info.value?.data?.parsed?.info ? `dec=${info.value.data.parsed.info.decimals}` : "");
