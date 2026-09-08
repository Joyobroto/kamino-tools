// Can we detect NEW POOLS on-chain in near-real-time via logsSubscribe or polling getSignaturesForAddress?
// Test: recent pumpswap program activity + how many "initialize" pool creations per hour.
import { readFileSync } from "node:fs";
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
// Pumpswap AMM program: pAMMBay6oceH9fJKbrHdcd3K6M9Wr3Hap9vdPZpRy2M? Actually pumpswap = "pAMMBay6oceH9fJKbrHdcd3K6M9Wr3Hap9vdPZpRy2M"
const PUMPSWAP = "pAMMBay6oceH9fJKbrHdcd3K6M9Wr3Hap9vdPZpRy2M";
const sigs = await rpcCall("getSignaturesForAddress", [PUMPSWAP, { limit: 100 }]);
console.log("recent pumpswap sigs:", sigs.length);
if (sigs.length) {
  const times = sigs.map(s => s.blockTime).filter(Boolean).sort();
  const span = times[times.length - 1] - times[0];
  console.log(`time span for 100 sigs: ${span}s → rate ≈ ${(100 / (span / 60)).toFixed(0)} tx/min`);
  // sample a few txs to see if any are pool creations
  for (const s of sigs.slice(0, 3)) {
    const tx = await rpcCall("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) continue;
    const ixs = [];
    const walk = (arr) => { for (const ix of arr) { if (ix.instructions) walk(ix.instructions); else ixs.push(ix); } };
    walk(tx.transaction.message.instructions);
    const pumpIxs = ixs.filter(ix => (ix.programId?.toString?.() ?? ix.programId) === PUMPSWAP);
    console.log(`tx ${s.signature.slice(0, 12)}… pumpswap ix count=${pumpIxs.length}`);
    await sleep(400);
  }
}
