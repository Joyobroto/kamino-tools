// Final verification round:
// 1) LBUZKh 904B vault offsets on GIGAANON pool (pumpswap-labeled by Gecko but owner=LBUZKh)
// 2) cpamdpZ: it's Phoenix? No — Phoenix events use a book. cpamdpZ pools hold vault balances → AMM.
//    Name doesn't matter for us; call it by program identity.
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
// GIGAANON pool (owner LBUZKh 904B):
const POOL = "2dBYkcrYjNxtB8dKQCkMTtvJ8jY9qQCGxqS3cbBzV5AA"; // from earlier: GIGAANON pumpswap pool id? use Gecko one:
// From new_pools file: GIGAANON pool addr wasn't recorded with address... use the meteora SOL/USDC 904B verified earlier:
const POOL2 = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const info = await rpcCall("getAccountInfo", [POOL2, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("pool 5rCf1DM8 len:", buf.length);
for (const off of [88, 120, 152, 184]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`@${off}: ${v.slice(0, 8)} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`@${off}: not token acct`); }
}
const mintA = bs58.encode(buf.subarray(88, 120));
const mintB = bs58.encode(buf.subarray(120, 152));
console.log("mintA@88:", mintA, "mintB@120:", mintB);
