// Identify the ANB mint (FkiJSGKD...) + the counterparty wallets + programs
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
// find full mint starting with FkiJSGKD from the tx accounts
const tx = await rpcCall("getTransaction", ["J8TY8VkjZpAAm78GwbnEE1xkBwGdheQ4C1VsZA7Cwcv1AyDw3PxTQJ3eWh9YZmZyLQnLD3fuHBsihXbX4sTATi8", { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
const keys = tx.transaction.message.accountKeys.map(k => k.pubkey ?? k);
const mint = keys.find(k => k.startsWith("FkiJSGKD"));
console.log("ANB mint:", mint);
const mintInfo = await rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
const mp = mintInfo.value?.data?.parsed;
console.log("mint supply:", mp?.info?.supply, "decimals:", mp?.info?.decimals);
// transfer fee / freeze / authority?
console.log("mint authority set?", !!mp?.info?.mintAuthority, "| freeze authority set?", !!mp?.info?.freezeAuthority);
// What is FkiJSGKD? check name via Jupiter tokens API
try {
  const res = await fetch(`https://tokens.jup.ag/tokens/${mint}`, { headers: { Accept: "application/json" } });
  if (res.ok) {
    const j = await res.json();
    console.log("Jupiter token meta:", JSON.stringify({ symbol: j.symbol, name: j.name, isVerified: j.isVerified, organicScore: j.organic_score, price: j.price }).slice(0, 300));
  } else console.log("jup meta status", res.status);
} catch (e) { console.log("jup meta err", e.message.slice(0, 60)); }
// Programs in the ANB txs:
const PROGRAMS = {
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "Phoenix?",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DAMM?",
  "sattCHvHkM4XHLyadnU4KQtuNWZbWVDKzuPhmJBXCkq": "?",
  "CvvQJ1HudQ2QrX5qvotTBz3FMWjrMQk8KyvRway7Bcj4": "?",
  "jesterKqzZ7hWfNLnUDeB8WtMrm7a44g2vSyhs7WmyT": "?",
};
for (const [pid, guess] of Object.entries(PROGRAMS)) {
  const acc = await rpcCall("getAccountInfo", [pid, { encoding: "base64" }]);
  console.log(`program ${pid.slice(0, 10)}… (${guess}) → executable:`, acc.value?.executable, "owner:", acc.value?.owner);
}
// wallets: 6CnzQU (the "user A" seller?), HLnpSz (recurring counterparty), 2QfBNK/ESuvjv (arbers)
console.log("\nCounterparties seen: HLnpSz9h… (in 9/20 LionX txs — SAME entity!), 6CnzQU…, 5Q544fKr…");
