// The vault addresses decoded wrong → offsets off. bs58-encode known WSOL/USDC to calibrate.
// Let's scan the 752-byte buffer for well-known mints (WSOL/USDC/USDT) by scanning every 32-byte window
// whose base58 decode equals a known mint.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await new Promise(r => setTimeout(r, 4000)); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited out");
}
const KNOWN = {
  "So11111111111111111111111111111111111111112": "WSOL",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
};
// pick a pool from the top of AMMv4 GPA list — but first pick one that actually contains WSOL:
// use memcmp on token0Mint? offset unknown. Instead: fetch first 40 pools fully? expensive.
// Simpler: use a KNOWN famous AMMv4 pool: SOL/USDC (Raydium AMMv4 official) — find via DexScreener later.
// Quick hack: scan first N GPA pools with dataSlice covering 13..141 bytes and find one containing WSOL bytes.
const WSOL_BYTES = bs58.decode("So11111111111111111111111111111111111111112");
const res = await rpcCall("getProgramAccounts", ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", {
  encoding: "base64",
  filters: [{ dataSize: 752 }, { memcmp: { offset: 107, bytes: "So11111111111111111111111111111111111111112" } }],
  dataSlice: { offset: 0, length: 0 },
  withContext: false,
}]);
console.log("pools with WSOL@107:", res.length);
if (res.length) {
  const key = res[0].pubkey;
  console.log("sample:", key);
  const info = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  console.log("len:", buf.length);
  const u64 = (o) => buf.readBigUInt64LE(o);
  const S = (o) => bs58.encode(buf.subarray(o, o + 32));
  console.log("token0Mint@75 :", S(75));
  console.log("token1Mint@107:", S(107));
  console.log("dec0@139:", buf[139], "dec1@140:", buf[140]);
  for (const [label, off] of [["vault0", 11], ["vault1", 43]]) {
    const v = S(off);
    try {
      const bal = await rpcCall("getTokenAccountBalance", [v]);
      console.log(`${label} ${v.slice(0,10)}… balance:`, bal.value.amount, "dec:", bal.value.decimals);
    } catch (e) { console.log(label, v, "ERR", e.message.slice(0, 60)); }
  }
}
