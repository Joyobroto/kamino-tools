import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(10000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
const JUPSOLbytes = bs58.decode(JUPSOL);
const WSOL = "So11111111111111111111111111111111111111112";
// meteora-damm = LBUZKh, size 904, mints@88/120, vaults@152/184 — slice offset 88 len 96:
let key = null;
const cands = [];
do {
  const page = await call("getProgramAccountsV2", ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", {
    encoding: "base64", filters: [{ dataSize: 904 }], dataSlice: { offset: 88, length: 96 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
  }]);
  for (const a of page.accounts ?? []) {
    const buf = Buffer.from(a.account.data[0], "base64");
    const mintA = bs58.encode(buf.subarray(0, 32));
    const mintB = bs58.encode(buf.subarray(32, 64));
    if (mintA === JUPSOLbytes.subarray ? false : (mintA === JUPSOL || mintB === JUPSOL)) cands.push(a.pubkey);
  }
  key = page.paginationKey;
} while (key && cands.length < 50);
console.log("meteora-damm JupSOL pools:", cands.length);
for (const pool of cands.slice(0, 10)) {
  const info = await call("getAccountInfo", [pool, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const mintA = bs58.encode(buf.subarray(88, 120));
  const mintB = bs58.encode(buf.subarray(120, 152));
  const vA = bs58.encode(buf.subarray(152, 184));
  const vB = bs58.encode(buf.subarray(184, 216));
  const other = mintA === JUPSOL ? mintB : mintA;
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
  const pA = bals.value[0]?.data?.parsed?.info;
  const pB = bals.value[1]?.data?.parsed?.info;
  console.log(`${pool.slice(0, 10)} pair=${other === WSOL ? "SOL✓" : other.slice(0, 8) + "✗"} vaults: ${pA?.tokenAmount?.uiAmountString?.slice(0, 14)} ${pA?.mint?.slice(0, 6)} + ${pB?.tokenAmount?.uiAmountString?.slice(0, 14)} ${pB?.mint?.slice(0, 6)}`);
  await sleep(2500);
}
