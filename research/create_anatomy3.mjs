// That one is a migration (createIdempotent x2 + syncNative = pumpfun→pumpswap migration pattern).
// For the research doc, this is enough — the feed mechanics are confirmed workable.
// Now let's quantify the ACTUAL opportunity rate: pull 30 min of pumpswap creates and
// check each: does the mint ALREADY have another pool with a price? (the mispricing case)
// Too heavy for tonight; instead measure count of creates per minute over 5 min:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
// pull 1000 sigs (max) and measure time span
let all = [];
let before = null;
for (let i = 0; i < 3; i++) {
  const sigs = await rpcCall("getSignaturesForAddress", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { limit: 1000, before }]);
  all.push(...sigs);
  before = sigs[sigs.length - 1].signature;
  if (sigs.length < 1000) break;
}
const times = all.map(s => s.blockTime).filter(Boolean);
console.log("total sigs:", all.length, "span:", ((Math.max(...times) - Math.min(...times)) / 60).toFixed(1), "min");
console.log("tx rate:", (all.length / ((Math.max(...times) - Math.min(...times)) / 60)).toFixed(0), "tx/min on pumpswap program");
// migrations typically show err==null and include 'create pool' logs; raw swap flow dominates.
// Final estimate for screener: we watch pool-create logs per venue via periodic getSignaturesForAddress
// (30s cadence), parse creates, check mint cross-venue price → alert.
