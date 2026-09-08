// Try all 32-byte aligned AND unaligned offsets for token accounts (brute force up to 400):
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
const key = "JEHPjzMdYPYZuQMhmM26oWE7fi5Emqg5sAN5uVYDAGhU";
const info = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
// batch check via getMultipleAccounts on token program ownership
const cands = [];
for (let off = 8; off <= 637 - 32; off++) cands.push(bs58.encode(buf.subarray(off, off + 32)));
// check in batches of 100 — look for accounts owned by TOKEN PROGRAM:
let found = [];
for (let i = 0; i < cands.length; i += 100) {
  const res = await rpcCall("getMultipleAccounts", [cands.slice(i, i + 100), { encoding: "base64" }]);
  res.forEach((acc, j) => {
    if (acc && acc.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      found.push({ offset: i + j, pubkey: cands[i + j] });
    }
  });
}
console.log("token accounts found at offsets:", found.map(f => f.offset));
// fetch their balances:
for (const f of found) {
  try {
    const bal = await rpcCall("getTokenAccountBalance", [f.pubkey]);
    console.log(`  @${f.offset} ${f.pubkey.slice(0, 8)} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`  @${f.offset} balance err (maybe Token2022)`); }
}
