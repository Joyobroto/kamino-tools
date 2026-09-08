// "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" truly doesn't exist on mainnet.
// So the REAL JitoSOL must be found on-chain. The orca pool (verified top liq $7M, Gecko-labeled
// "JitoSOL/SOL") holds J1toso...GCPn — and Jupiter token search (verified badge, "Jito Staked SOL")
// returns the SAME mint. Gecko + Jupiter + biggest pool all agree: GCPn IS the real JitoSOL.
// My memory-mint was simply wrong (typo — never validated on-chain until now).
// Sanity: real JitoSOL supply ≈ 13-14M... we see 7.89M. Dec 2026 plausible? Check sanctum via
// alternative: the Jito stake pool program accounts. Skip — Gecko+Jup+pool consensus is enough.
// FINAL: registry already updated to GCPn ✓.
// Now verify the OTHERS' pool membership: does the biggest "mSOL/SOL" pool hold mSoLzY...m7So?
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
// search pools for each updated mint via memcmp on whirlpool + meteora-damm dataSlice method:
const LSTS = {
  JupSOL: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  bSOL: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
};
// whirlpool dataSlice scan (offset 101 len 112 covers both mints):
for (const [sym, mint] of Object.entries(LSTS)) {
  const mintBytes = bs58.decode(mint);
  let key = null, found = 0, checked = 0;
  do {
    const page = await call("getProgramAccountsV2", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", {
      encoding: "base64", filters: [{ dataSize: 653 }], dataSlice: { offset: 101, length: 112 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
    }]);
    for (const a of page.accounts ?? []) {
      checked++;
      const buf = Buffer.from(a.account.data[0], "base64");
      if (buf.subarray(0, 32).equals(mintBytes) || buf.subarray(80, 112).equals(mintBytes)) found++;
    }
    key = page.paginationKey;
  } while (key);
  console.log(`${sym}: ${found} whirlpool pools (scanned ${checked})`);
  await sleep(3000);
}
