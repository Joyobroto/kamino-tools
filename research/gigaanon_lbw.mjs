// GIGAANON pool CaXcEFx6… labeled pumpswap by Gecko — check its actual owner:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const info = await rpcCall("getAccountInfo", ["CaXcEFx6CxKm2gHeTNDgqBNKzNQmQYdZhoMZpSim89hH", { encoding: "base64" }]);
console.log("owner:", info.value?.owner, "space:", Buffer.from(info.value.data[0], "base64").length);
