// Verify what program 675kPX... actually is: check a known key against Solscan via RPC getAccountInfo owner
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
// The account key 5JWiQSrDZX1yghrEfSHNs3TR1VRpMv9PQsc5G3U17fkT — getAccountInfo
for (const k of ["5JWiQSrDZX1yghrEfSHNs3TR1VRpMv9PQsc5G3U17fkT", "B3c63dUHXcoMJbMMwZGcbJoGo2MdGNkpDnLH13jAMCBw"]) {
  const info = await rpcCall("getAccountInfo", [k, { encoding: "base64" }]);
  console.log(k, "→ owner:", info.value?.owner, "lamports:", info.value?.lamports, "dataLen:", info.value?.data?.[1] === "base64" ? Buffer.from(info.value.data[0], "base64").length : "n/a");
}
// Also: is 675kPX... maybe NOT the AMM program? Check famous Raydium AMMv4 pool SOL/USDC:
const RAY_SOL_USDC_AMMV4 = "58oQChx4yWmvKFEliTcm6qDEqb2dDYdErGLhMmSSyDCh"; // This is actually Meteora DLMM? let me check owner:
const info = await rpcCall("getAccountInfo", [RAY_SOL_USDC_AMMV4, { encoding: "base64" }]);
console.log("\n58oQChx4yWmvKFEliTcm6qDEqb2dDYdErGLhMmSSyDCh owner:", info.value?.owner);
