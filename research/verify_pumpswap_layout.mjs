// BEFORE finalizing venues.ts — verify pumpswap 301-byte layout empirically on the WOFI pool!
// Decode candidate offsets by searching for known mint bytes (WOFI mint + WSOL):
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
const POOL = "Gep9f4K4bxvVZtdQhQNS2Tje9qGCTSwcfhZceFmxDd4N"; // WOFI/SOL pumpswap
const WOFI = "8zHUqV2PxzsDj1D8PkL6AX5tYTYSZNWCiKRnpX6Bpump";
const WSOL = "So11111111111111111111111111111111111111112";
const info = await rpcCall("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("pool len:", buf.length);
for (const [sym, mint] of [["WOFI", WOFI], ["WSOL", WSOL]]) {
  const b = bs58.decode(mint);
  for (let off = 0; off <= buf.length - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== b[i]) { ok = false; break; }
    if (ok) console.log(`${sym} mint @ offset ${off}`);
  }
}
// full hex dump:
for (let i = 0; i < buf.length; i += 32) console.log(String(i).padStart(3), buf.subarray(i, i + 32).toString("hex"));
