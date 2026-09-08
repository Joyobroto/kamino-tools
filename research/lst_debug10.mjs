// PATTERN FOUND: USDC@101/181 = thousands of hits. WSOL works. mSOL@any = 0. JitoSOL = 0.
// But mSOL/JitoSOL pools EXIST (Gecko showed them!). → Helius memcmp 'bytes' seems to have
// a max byte-length constraint: base58 WSOL/USDC = 43 chars; JitoSOL/mSOL = 44 chars!
// 44 base58 chars = 33+ bytes?? The RPC memcmp spec: 'bytes' max 29 BYTES when base58-encoded
// data is ≤ 29 bytes... Actually Solana docs: "bytes - base58-encoded, limited to 29 BYTES".
// Pubkeys are 32 bytes — TOO LONG for memcmp by spec! But USDC/WSOL work because their leading
// zeros compress in base58: 'So111...1' with leading 0x00 bytes → base58 drops them → 43 chars
// still encodes 32 bytes... hmm. BUT empirically: 43-char keys work, 44-char keys return 0.
// SOLution: use base64 encoding for memcmp bytes? The 'bytes' field is base58-only per spec.
// WORKAROUND: use the DATA SLICE + client-side filter! Fetch whirlpool pools with dataSlice
// covering the mint region (101..213 = 112 bytes + margin) and filter locally.
// Cost: 156K pools × ~130 bytes = manageable with V2 pagination!
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
// V2 with dataSlice 101..213 on whirlpool pools; local filter for JitoSOL:
const JITO = bs58.decode("J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe");
let key = null, found = [];
do {
  const page = await call("getProgramAccountsV2", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", {
    encoding: "base64", filters: [{ dataSize: 653 }],
    dataSlice: { offset: 101, length: 112 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
  }]);
  for (const a of page.accounts ?? []) {
    const buf = Buffer.from(a.account.data[0], "base64");
    // mintA at slice offset 0 (abs 101), mintB at slice offset 80 (abs 181)
    if (buf.subarray(0, 32).equals(JITO) || buf.subarray(80, 112).equals(JITO)) found.push(a.pubkey);
  }
  key = page.paginationKey;
} while (key && found.length < 500);
console.log("JitoSOL pools found via dataSlice-scan:", found.length);
console.log(found.slice(0, 5));
console.log("Hp53XEtt among them:", found.includes("Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp"));
