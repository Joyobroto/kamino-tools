// ANB: 6 decimals, supply 9,990,492,739 raw?? No wait: supply 9,990,492,739,256,224 raw /1e6 = 9.99B tokens.
// Hmm 9990492739256224/1e6 = 9,990,492,739 = ~10B ANB. Pool A ANB vault 602,246,963,606,997/1e6 = 602M ANB ✓ plausible (6% of supply).
// USDC vault 28,005,441 raw/1e6 = $28.01. So Pool A = $28 USDC + 602M ANB — Gecko's "$6.1M liquidity" = ANB side marked at $0.0096 = $5.78M.
// → the $6.1M is GHOST value: 602M ANB marked at a price NOBODY can realize (only $28 USDC in the pool).
// Actual current price in pool A: 28.01/602.2M = 4.65e-8 — ANB is WORTHLESS in this pool now.
// Pool D: $0.016 + 442.69 ANB → also dust.
// CONCLUSION: ANB "spread" is a mirage of stale Gecko prices vs real one-sided graves.
// What about pool B/C (dammv2 $240K liq)? They had NO vaults under Tokenkeg... check Token-2022 & whether vault owner is a PDA:
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
// DAMMv2 pool: Ee8hN27zmvpkX4LimkuYz5UmjyNv2Vc1XbCvyvyohmfp — hexdump to find vault PDAs
const info = await rpcCall("getAccountInfo", ["Ee8hN27zmvpkX4LimkuYz5UmjyNv2Vc1XbCvyvyohmfp", { encoding: "base64" }]);
if (!info.value) { console.log("pool B account gone"); process.exit(0); }
const buf = Buffer.from(info.value.data[0], "base64");
console.log("pool B len:", buf.length);
// find ANB & USDC mint offsets:
for (const [sym, mint] of [["ANB", "FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj"], ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]]) {
  const b = bs58.decode(mint);
  for (let off = 0; off <= buf.length - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== b[i]) { ok = false; break; }
    if (ok) console.log(`${sym} mint at offset ${off}`);
  }
}
// dump 64 bytes of head:
console.log("head:", buf.subarray(0, 64).toString("hex"));
