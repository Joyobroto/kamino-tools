// Anatomy of ONE pool-create tx: what mints, what initial liquidity ratio, and is there an instant arb?
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const sig = "5bFNwr47d6JHYHgnBUiE"; // truncated earlier — need full sig. Re-fetch list:
const sigs = await rpcCall("getSignaturesForAddress", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { limit: 50 }]);
const full = sigs.find(s => s.signature.startsWith("5bFNwr47"))?.signature;
console.log("full sig:", full);
if (full) {
  const tx = await rpcCall("getTransaction", [full, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  const meta = tx.meta;
  // new token balances appearing = initial liquidity deposit
  const newBalances = (meta.postTokenBalances ?? []).filter(b => !(meta.preTokenBalances ?? []).find(p => p.accountIndex === b.accountIndex));
  console.log("initial liquidity tokens deposited:");
  for (const b of newBalances) {
    console.log(`  mint ${b.mnt ?? b.mint} amount ${b.uiTokenAmount.amount} (${b.uiTokenAmount.decimals}dec) owner ${b.owner?.slice(0, 8)}…`);
  }
}
