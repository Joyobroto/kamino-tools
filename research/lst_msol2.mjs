import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { console.error("429"); await sleep(12000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const MSOLbytes = bs58.decode("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
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
} while (key && found.length < 20);
console.log("CLMM mSOL pools:", found.slice(0, 3));
for (const pool of found.slice(0, 2)) {
  const info = await call("getAccountInfo", [pool, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const vA = bs58.encode(buf.subarray(137, 169));
  const vB = bs58.encode(buf.subarray(169, 201));
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
  console.log(`\npool ${pool}:`);
  for (const b of bals.value) {
    const p = b?.data?.parsed?.info;
    if (p) console.log(`  vault mint=${p.mint.slice(0, 10)} amount=${p.tokenAmount.uiAmountString}`);
  }
  await sleep(3000);
}
