// Sanity: mSOL "premium 35%": probe sells $500 worth at pool-rate-hint (mSOL≈1.25 SOL?) but
// receives $677 — means Jupiter pays MORE than our deepest-pool price → either the deepest
// pool is mispriced (impossible for mSOL/CLMM 3600 SOL deep) or the HINT sizing is wrong:
// probeLstUi = 500 / (solPrice × deepest.priceSolPerLst). If deepest price is WRONG (too low),
// we buy too much LST and Jupiter pays fair value → fake "premium".
// Check the mSOL CLMM pool vaults directly:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
// find the deepest CLMM mSOL/SOL pool: from our scanner logic — search CLMM pools with dataSlice:
const WSOL = bs58.decode("So11111111111111111111111111111111111111112");
const MSOLbytes = bs58.decode(MSOL);
let key = null, found = [];
do {
  const page = await call("getProgramAccountsV2", ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", {
    encoding: "base64", filters: [{ dataSize: 1544 }], dataSlice: { offset: 73, length: 96 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
  }]);
  for (const a of page.accounts ?? []) {
    const buf = Buffer.from(a.account.data[0], "base64");
    // mintA@73 (slice 0..32), mintB@105 (slice 32..64), vaultA@137 (slice 64..96), vaultB@169 — BEYOND slice!
    if (buf.subarray(0, 32).equals(MSOLbytes) || buf.subarray(32, 64).equals(MSOLbytes)) found.push(a.pubkey);
  }
  key = page.paginationKey;
} while (key && found.length < 20);
console.log("CLMM mSOL pools:", found.length, found.slice(0, 3));
// hydrate the first: full account + vaults:
if (found[0]) {
  const info = await call("getAccountInfo", [found[0], { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const vA = bs58.encode(buf.subarray(137, 169));
  const vB = bs58.encode(buf.subarray(169, 201));
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
  for (const b of bals.value) {
    const p = b?.data?.parsed?.info;
    console.log("vault:", p?.mint?.slice(0, 10), p?.tokenAmount?.uiAmountString);
  }
}
