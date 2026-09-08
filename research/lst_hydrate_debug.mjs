// Trace the exact hydrate logic on all CLMM mSOL pools to find where the SOL depth=3618 came from.
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
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const MSOLbytes = bs58.decode(MSOL);
const WSOL = "So11111111111111111111111111111111111111112";
// collect ALL CLMM pools w/ mSOL (up to 20) then check their pair:
let key = null, found = [];
do {
  const page = await call("getProgramAccountsV2", ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", {
    encoding: "base64", filters: [{ dataSize: 1544 }], dataSlice: { offset: 73, length: 96 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
  }]);
  for (const a of page.accounts ?? []) {
    const buf = Buffer.from(a.account.data[0], "base64");
    if (buf.subarray(0, 32).equals(MSOLbytes) || buf.subarray(32, 64).equals(MSOLbytes)) found.push(a.pubkey);
  }
  key = page.paginationKey;
} while (key && found.length < 30);
console.log("all CLMM mSOL pools found:", found.length);
// check each: pair mint + vaults (batched):
const infos = await call("getMultipleAccounts", [found.slice(0, 20), { encoding: "base64" }]);
for (let i = 0; i < Math.min(found.length, 20); i++) {
  const acc = infos.value[i];
  if (!acc) continue;
  const buf = Buffer.from(acc.data[0], "base64");
  const mintA = bs58.encode(buf.subarray(73, 105));
  const mintB = bs58.encode(buf.subarray(105, 137));
  const vA = bs58.encode(buf.subarray(137, 169));
  const vB = bs58.encode(buf.subarray(169, 201));
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
  const pA = bals.value[0]?.data?.parsed?.info;
  const pB = bals.value[1]?.data?.parsed?.info;
  const isSol = mintA === WSOL || mintB === WSOL;
  console.log(`${found[i].slice(0, 10)} ${mintA === MSOL ? "mSOL" : mintA === WSOL ? "WSOL" : mintA.slice(0, 6)}/${mintB === MSOL ? "mSOL" : mintB === WSOL ? "WSOL" : mintB.slice(0, 6)} ${isSol ? "✓SOL-pair" : "✗"} vaults: ${pA?.tokenAmount?.uiAmountString?.slice(0, 12)} + ${pB?.tokenAmount?.uiAmountString?.slice(0, 12)}`);
  await sleep(2000);
}
