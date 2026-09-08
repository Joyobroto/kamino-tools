// Fetch fresh sigs and dissect the first CREATE-typed tx fully.
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const sigs = await rpcCall("getSignaturesForAddress", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { limit: 30 }]);
for (const s of sigs.slice(0, 10)) {
  const tx = await rpcCall("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) continue;
  const flat = [];
  const walk = (arr) => arr.forEach(ix => { if (ix.instructions) walk(ix.instructions); else flat.push(ix); });
  walk(tx.transaction.message.instructions);
  const creates = flat.filter(ix => /create|initialize/i.test(ix.parsed?.type ?? ""));
  if (!creates.length) continue;
  console.log("CREATE tx:", s.signature);
  console.log("  ix types:", flat.map(ix => `${ix.parsed?.type ?? ix.programId?.toString?.().slice(0, 6) ?? "?"}`).join(", ").slice(0, 200));
  const meta = tx.meta;
  const pre = meta.preTokenBalances ?? [], post = meta.postTokenBalances ?? [];
  const newBal = post.filter(b => !pre.find(p => p.accountIndex === b.accountIndex));
  for (const b of newBal) {
    console.log(`  DEPOSIT mint=${b.mint.slice(0, 10)}… amount=${b.uiTokenAmount.amount} (${b.uiTokenAmount.decimals}dec)`);
  }
  break;
}
