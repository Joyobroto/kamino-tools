// Instrument hydrateLstViews for mSOL specifically to see WHICH pool becomes deepest.
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
// Replicate the CLMM slice exactly as the scanner does (offset 73, len 96):
// NOTE: slice covers mintA(73..105) mintB(105..137) vaultA(137..169) — vaultB@169 is OUTSIDE!
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const MSOLbytes = bs58.decode(MSOL);
const WSOL = "So11111111111111111111111111111111111111112";
let key = null;
const cands = [];
do {
  const page = await call("getProgramAccountsV2", ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", {
    encoding: "base64", filters: [{ dataSize: 1544 }], dataSlice: { offset: 73, length: 96 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
  }]);
  for (const a of page.accounts ?? []) {
    const buf = Buffer.from(a.account.data[0], "base64");
    const mintA = bs58.encode(buf.subarray(0, 32));
    const mintB = bs58.encode(buf.subarray(32, 64));
    if (mintA === MSOL || mintB === MSOL) cands.push(a.pubkey);
  }
  key = page.paginationKey;
} while (key);
console.log("CLMM mSOL candidates:", cands.length);
// hydrate each EXACTLY like scanner (decode FULL pool, check SOL pair, price):
for (const pool of cands.slice(0, 40)) {
  const info = await call("getAccountInfo", [pool, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const mintA = bs58.encode(buf.subarray(73, 105));
  const mintB = bs58.encode(buf.subarray(105, 137));
  const vA = bs58.encode(buf.subarray(137, 169));
  const vB = bs58.encode(buf.subarray(169, 201));
  const other = mintA === MSOL ? mintB : mintA;
  if (other !== WSOL) continue;
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
  const pA = bals.value[0]?.data?.parsed?.info;
  const pB = bals.value[1]?.data?.parsed?.info;
  if (!pA || !pB) continue;
  const isLstA = mintA === MSOL;
  const lstUi = Number((isLstA ? pA : pB).tokenAmount.amount) / 10 ** (isLstA ? pA : pB).tokenAmount.decimals;
  const solUi = Number((isLstA ? pB : pA).tokenAmount.amount) / 10 ** (isLstA ? pB : pA).tokenAmount.decimals;
  console.log(`SOL-pair ${pool.slice(0, 10)}: ${lstUi} mSOL + ${solUi} SOL → rate ${(solUi / lstUi).toFixed(4)}`);
  await sleep(2500);
}
