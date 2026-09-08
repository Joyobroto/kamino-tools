// Raydium AMMv4 pool layout decode (research)
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpcCall(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(4000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited out");
}
const info = await rpcCall("getAccountInfo", ["B3c63dUHXcoMJbMMwZGcbJoGo2MdGNkpDnLH13jAMCBw", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
const S = (o) => bs58.encode(buf.subarray(o, o + 32));
const u64 = (o) => buf.readBigUInt64LE(o);
console.log("=== Raydium AMMv4 layout check ===");
console.log("status          (0..6):", buf.subarray(0, 6).toString("hex"));
console.log("nonce           (6):", buf[6]);
console.log("maxVelo         (7..11):", buf.readUInt32LE(7));
console.log("token0Vault    (13):", S(13));
console.log("token1Vault    (45):", S(45));
console.log("token0Mint     (77):", S(77));
console.log("token1Mint     (109):", S(141 - 32));
// standard layout: status6 nonce1 maxVelo4 token0Vault32 token1Vault32 token0Mint32 token1Mint32 token0Decimals1 token1Decimals1 ...
console.log("token0Dec      (173):", buf[173]);
console.log("token1Dec      (174):", buf[174]);
console.log("targetOrders?  etc");
console.log("reserve0 [getSlot? skip]");
console.log("full hex dump first 260 bytes:");
for (let i = 0; i < 260; i += 32) {
  console.log(` ${String(i).padStart(3)}: ${buf.subarray(i, i + 32).toString("hex")}`);
}
