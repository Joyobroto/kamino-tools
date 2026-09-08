// 705K pools fetched in ONE call — good (Helius GPA dataSlice works). No WSOL in first batch mint slots @75/107.
// Maybe AMMv4 layout differs: token0Mint@76? Let's hex-dump a known WSOL pool.
// Find via vault addresses: Raydium SOL/USDC AMMv4 pool = "8HoQnePLqPpj4qP2QEZQzA5wJo4uJ3XQM7JB1Km7xxqx"? (that's newer)
// Better: use memcmp filter on ANY offset — binary search offset by trying WSOL memcmp at several offsets.
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
const WSOL = "So11111111111111111111111111111111111111112";
const PROG = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
for (const off of [75, 76, 77, 107, 108, 109]) {
  try {
    const res = await rpcCall("getProgramAccounts", [PROG, {
      encoding: "base64", filters: [{ dataSize: 752 }, { memcmp: { offset: off, bytes: WSOL } }],
      dataSlice: { offset: 0, length: 0 }, withContext: false,
    }]);
    console.log(`offset ${off}: ${res.length} pools`);
  } catch (e) { console.log(`offset ${off} ERR`, e.message.slice(0, 60)); }
  await sleep(1500);
}
