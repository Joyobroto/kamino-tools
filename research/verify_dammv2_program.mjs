// Verify: (1) owner of the ANB pool whose layout we verified (mints@168/200, vaults@232/264)
// (2) pool counts per candidate program (3) Eo7WjKq 944-byte layout via the JitoSOL/SOL pool
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
// 1) ANB DAMMv2 pool owner
const info = await rpcCall("getAccountInfo", ["Ee8hN27zmvpkX4LimkuYz5UmjyNv2Vc1XbCvyvyohmfp", { encoding: "base64" }]);
console.log("ANB pool len:", Buffer.from(info.value.data[0], "base64").length, "owner:", info.value.owner);

// 2) counts: candidate DAMMv2 programs with pool sizes
for (const [label, prog, size] of [
  ["cpamdpZ @1112", "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", 1112],
  ["Eo7WjKq @944", "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", 944],
  ["LBUZKh @904", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", 904],
]) {
  try {
    const r = await rpcCall("getProgramAccounts", [prog, { encoding: "base64", filters: [{ dataSize: size }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
    console.log(label, "→", r.length, "accounts");
  } catch (e) { console.log(label, "ERR", e.message.slice(0, 90)); }
  await sleep(800);
}

// 3) Eo7WjKq 944 layout: JitoSOL/SOL pool ERgpKaq59…
const POOL = "ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw";
const pi = await rpcCall("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(pi.value.data[0], "base64");
console.log("\nERgpKaq59 len:", buf.length, "owner:", pi.value.owner);
for (const [sym, mint] of [["JitoSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe"], ["WSOL", "So11111111111111111111111111111111111111112"]]) {
  const b = bs58.decode(mint);
  for (let off = 0; off <= buf.length - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== b[i]) { ok = false; break; }
    if (ok) console.log(`${sym} mint @ offset ${off}`);
  }
}
// vaults: token accounts owned by the pool
const res = await rpcCall("getProgramAccounts", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", {
  encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: POOL } }], withContext: false,
}]);
console.log("vaults owned by pool:", res.length);
for (const r of res) {
  const vb = Buffer.from(r.account.data[0], "base64");
  const mint = bs58.encode(vb.subarray(0, 32));
  const amt = vb.readBigUInt64LE(64);
  console.log("  vault mint:", mint.slice(0, 8), "amount:", amt.toString());
  const vbytes = bs58.decode(r.pubkey);
  for (let off = 0; off <= buf.length - 32; off++) {
    let ok = true;
    for (let i = 0; i < 32; i++) if (buf[off + i] !== vbytes[i]) { ok = false; break; }
    if (ok) console.log("    ↳ vault pubkey at pool offset", off);
  }
}
