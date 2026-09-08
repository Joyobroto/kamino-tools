// Empirical layout via calibration pool: WSOL@400, USDC@432 (752B).
// Hypothesis: layout = status(6) nonce(1) maxVelo(4) vault0(32)@11 vault1(32)@43
// program0(32)@75 program1(32)@107 ... many u64 fields ... mints LATER at 400/432.
// Cross-check with vault token balances: derive vaults at 11/43 and fetch balances.
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
const info = await rpcCall("getAccountInfo", ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
const S = (o) => bs58.encode(buf.subarray(o, o + 32));
console.log("vault0@11:", S(11));
console.log("vault1@43:", S(43));
for (const v of [S(11), S(43)]) {
  const bal = await rpcCall("getTokenAccountBalance", [v]);
  console.log("vault", v, "→", bal.value.amount, `(${bal.value.decimals} dec)`, "ui:", bal.value.uiAmountString);
}
// token program ids at 75/107?
console.log("field@75 :", S(75));
console.log("field@107:", S(107));
console.log("(expect TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP = Token Program)");
// reserves: search u64 pairs whose product matches vault balances. vault WSOL bal vs candidates:
// print u64s from 320..400 region and 464..540
const u64 = (o) => buf.readBigUInt64LE(o);
console.log("\nu64 @ 320..400:");
for (let o = 320; o < 400; o += 8) console.log(`  @${o}:`, u64(o).toString());
