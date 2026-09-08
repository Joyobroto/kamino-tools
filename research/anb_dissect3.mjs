// Correct Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA (ends Q5DA, not QXDAP — typo earlier!)
// Re-run ANB pool dissection:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhMpASfgMQLBV4hYsXhHtHjCgwm";
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
const MINT = "FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const POOLS = [
  ["A: ANB/USDC meteora $0.0096 liq$6.1M", "6CnzQUJqFBdPUsB1XT7TPYUoKUn8NRML23SyNwwxAQr2"],
  ["B: ANB/USDC dammv2 $0.000018 liq$240K", "Ee8hN27zmvpkX4LimkuYz5UmjyNv2Vc1XbCvyvyohmfp"],
  ["C: ANB/SOL dammv2 $0.0000095 liq$36K", "AsMnYhR1qZpeDMsu9D5kJYPYQtn8KsFpqe6ATV64yQHJ"],
  ["D: ANB/USDC meteora $0.0000136 liq$16K", "3t6umb3mwQW3DcD6ucthhPLZzXiKH1P2LDbV1avtvDfk"],
];
for (const [label, pool] of POOLS) {
  const res = await rpcCall("getProgramAccounts", [TOKEN, {
    encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: pool } }], withContext: false,
  }]);
  const res22 = await rpcCall("getProgramAccounts", [TOKEN22, {
    encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: pool } }], withContext: false,
  }]);
  console.log(`\n=== ${label} ===`);
  for (const r of [...res, ...res22]) {
    const buf = Buffer.from(r.account.data[0], "base64");
    const mint = bs58.encode(buf.subarray(0, 32));
    const amount = buf.readBigUInt64LE(64);
    const tag = mint === MINT ? "ANB" : mint === USDC ? "USDC" : mint === WSOL ? "WSOL" : mint.slice(0, 8);
    console.log(`  vault [${tag}] raw amount: ${amount.toString()}`);
  }
  await sleep(500);
}
