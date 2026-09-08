// Correct Pumpswap program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
// Measure pool-creation rate: how many "createPool/initialize" txs per hour?
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
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const sigs = await rpcCall("getSignaturesForAddress", [PUMPSWAP, { limit: 200 }]);
console.log("pumpswap recent sigs:", sigs.length);
const times = sigs.map(s => s.blockTime).filter(Boolean).sort((a, b) => b - a);
if (times.length > 1) console.log("newest:", new Date(times[0] * 1000).toISOString(), "| oldest of 200:", new Date(times[times.length - 1] * 1000).toISOString());
// count create-pool: sample 30 txs and look for pumpswap create instructions
let created = 0, checked = 0;
for (const s of sigs.slice(0, 30)) {
  const tx = await rpcCall("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  checked++;
  if (!tx) continue;
  // look for 'create' in inner instructions OR new pool accounts in loaded addresses... simpler: check for
  // parsed instruction name containing create/initialize
  const flat = [];
  const walk = (arr) => arr.forEach(ix => { if (ix.instructions) walk(ix.instructions); else flat.push(ix); });
  walk(tx.transaction.message.instructions);
  const isCreate = flat.some(ix => /create|initialize/i.test(ix.parsed?.type ?? ""));
  const hasPump = flat.some(ix => (ix.programId?.toString?.() ?? ix.programId) === PUMPSWAP) ||
    (tx.meta?.innerInstructions ?? []).some(ii => flat.some(() => false));
  if (isCreate) { created++; console.log("CREATE tx:", s.signature.slice(0, 20), new Date((s.blockTime ?? 0) * 1000).toISOString()); }
  await sleep(300);
}
console.log(`checked ${checked} txs, found ${created} creates`);
