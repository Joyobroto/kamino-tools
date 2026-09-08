// Debug: manually diff one venue and decode a new pool to find the error source
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
const VENUES = [
  ["pumpswap", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", 301],
  ["meteora-damm-v2", "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", 944],
];
const known = new Map();
for (const [name, prog, size] of VENUES) {
  const pools = await rpcCall("getProgramAccounts", [prog, { encoding: "base64", filters: [{ dataSize: size }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
  known.set(name, new Set(pools.map(p => p.pubkey)));
  console.log(name, "baseline:", pools.length);
}
await sleep(90_000);
for (const [name, prog, size] of VENUES) {
  const pools = await rpcCall("getProgramAccounts", [prog, { encoding: "base64", filters: [{ dataSize: size }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
  const fresh = pools.map(p => p.pubkey).filter(p => !known.get(name).has(p));
  console.log(name, "new pools in 90s:", fresh.length);
  for (const poolAddr of fresh.slice(0, 3)) {
    // simulate what the scanner does: getMultipleAccounts → decode
    const accs = await rpcCall("getMultipleAccounts", [[poolAddr], { encoding: "base64" }]);
    console.log("  account:", accs[0]?.value ? "exists" : "null?", JSON.stringify(accs).slice(0, 200));
  }
}
