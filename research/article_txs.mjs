// Dissect the article's example arb txs (ANB etc) via getTransaction
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
const TXS = {
  "ANB-tx1 (triangle arb example)": "J8TY8VkjZpAAm78GwbnEE1xkBwGdheQ4C1VsZA7Cwcv1AyDw3PxTQJ3eWh9YZmZyLQnLD3fuHBsihXbX4sTATi8",
  "ANB-tx2 (141 SOL bribe example)": "3GRCRJmVhSKM2M1wcZ1vQVvNwUT2j5WWJhufVzvY2EMa8rE3mu5PjDUCpHVpXkth26wqhTuWFHkixwdy7zGtWC1h",
  "dex-to-dex arb example": "5zwwFzqsDFRf6FnGz5rrAbWuFPExqb7tYmSk1uTvWF8x7Cu272XFPoU8nCfnAXbCYZTHV74PDgTqm9hSQrf8uX8j",
  "internal dex arb example": "3pb5512ttABHr8mKCM8MTfqTHqbQYxuFMQu8vrof6j24fdRz3LSp4LiLoNhbjtNec43UjFivQGTjjDEKaJ5AYhtx",
};
for (const [label, sig] of Object.entries(TXS)) {
  try {
    const tx = await rpcCall("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) { console.log(`\n=== ${label} → not found (pruned?) ===`); continue; }
    const meta = tx.meta;
    console.log(`\n=== ${label} ===`);
    console.log("blockTime:", new Date(tx.blockTime * 1000).toISOString(), "slot:", tx.slot);
    console.log("fee:", meta.fee, "lamports | CU consumed:", meta.computeUnitsConsumed);
    // jito tip? look for transfers to Jito tip accounts
    const jitoTips = (meta.postBalances && tx.transaction.message.accountKeys) ? null : null;
    // token balance changes for the fee payer (first account)
    const owner = tx.transaction.message.accountKeys[0].pubkey ?? tx.transaction.message.accountKeys[0];
    console.log("fee payer:", owner.toString?.() ?? owner);
    const pre = meta.preTokenBalances ?? [];
    const post = meta.postTokenBalances ?? [];
    const changes = {};
    for (const b of post) {
      const key = `${b.mint.slice(0, 8)}(${b.owner.slice(0, 6)})`;
      const prev = pre.find(p => p.accountIndex === b.accountIndex);
      const delta = BigInt(b.uiTokenAmount.amount) - BigInt(prev?.uiTokenAmount.amount ?? "0");
      if (delta !== 0n) changes[key] = (changes[key] ?? 0n) + delta;
    }
    for (const b of pre) {
      if (!post.find(p => p.accountIndex === b.accountIndex)) {
        const key = `${b.mint.slice(0, 8)}(closed)`;
        changes[key] = (changes[key] ?? 0n) - BigInt(b.uiTokenAmount.amount);
      }
    }
    console.log("token deltas by mint(owner):");
    for (const [k, v] of Object.entries(changes).sort((a, b) => Number(BigInt(b[1]) - BigInt(a[1])))) {
      console.log("  ", k.padEnd(18), v.toString());
    }
    // instruction programs invoked
    const progCounts = {};
    for (const ix of tx.transaction.message.instructions) {
      const pid = ix.programId?.toString?.() ?? ix.programId;
      progCounts[pid] = (progCounts[pid] ?? 0) + 1;
    }
    console.log("programs invoked:", JSON.stringify(progCounts, null, 1).slice(0, 800));
  } catch (e) {
    console.log(`\n=== ${label} ERR: ${e.message.slice(0, 120)}`);
  }
  await sleep(1200);
}
