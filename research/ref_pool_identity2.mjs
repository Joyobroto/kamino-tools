import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const POOL = "AWRUuFUhG9yncxKaXvjyUAbhmenEvnAT7ec4vYPf9Qo6";
const info = await call("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("Jupiter-ref pool owner:", info.value.owner, "size:", buf.length);
const mintA = bs58.encode(buf.subarray(168, 200));
const mintB = bs58.encode(buf.subarray(200, 232));
console.log("mintA:", mintA.slice(0, 12), "mintB:", mintB.slice(0, 12));
const vA = bs58.encode(buf.subarray(232, 264));
const vB = bs58.encode(buf.subarray(264, 296));
for (const [label, v] of [["vaultA", vA], ["vaultB", vB]]) {
  try {
    const bal = await call("getTokenAccountBalance", [v]);
    console.log(label, v.slice(0, 8), "→", bal.value.uiAmountString, `(${bal.value.decimals}dec)`);
  } catch { console.log(label, "not token acct"); }
  await sleep(1000);
}
