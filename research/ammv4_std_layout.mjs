// WSOL@400, USDC@432 — that means the standard AMMv4 layout has mints NOT at 75/107.
// Raydium AMMv4 actual layout (from source): 
// status(6) nonce(1) maxVelo(4) token0Vault(32)@11 token1Vault(32)@43 token0ProgramId(32)@75 token1ProgramId(32)@107
// token0Mint(32)@139? — but we found @400... that's not right either. Let me hex dump 320..752:
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
const info = await rpcCall("getAccountInfo", ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
for (let i = 320; i < 752; i += 32) console.log(String(i).padStart(4), buf.subarray(i, i + 32).toString("hex"));
console.log("\nu64 views around interesting spots:");
const u64 = (o) => buf.readBigUInt64LE(o);
for (const off of [176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256, 264, 272, 280, 288, 296, 304, 312, 320, 328, 336, 344, 352, 360, 368, 376, 384, 392]) console.log(`@${off}:`, u64(off).toString());
