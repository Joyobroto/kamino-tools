// pumpswap FINAL: mintA@43, mintB@75, vaultA@139, vaultB@171 ✓ (18.1M WOFI + 956 SOL)
// Wait — vault@139 holds 18.1M units 6dec = WOFI; vault@171 956 units 9dec = WSOL ✓
// Now verify the other guessed layouts: DLMM(904), CLMM(1544), CPMM(637), AMMv4(752), Whirlpool(653)
// Known pools:
//  DLMM "meteora" SOL/USDC: 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6 owner=LBUZKh... (904)
//  CLMM: 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv owner=CAMMCzo5... (1544)
//  AMMv4: 58oQChx4... (752) mints@400/432 known
//  Whirlpool: Czfq3xZZ... (653)
//  CPMM: pick one 637-byte account from GPA + verify
import { readFileSync } from "node:fs";
import bs58 from "bs58";
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
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const pools = [
  ["DLMM 5rCf1DM8…", "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"],
  ["CLMM 3ucNos4N…", "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"],
  ["Whirlpool Czfq3xZZ…", "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"],
];
for (const [label, key] of pools) {
  const info = await rpcCall("getAccountInfo", [key, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  const hits = {};
  for (const [sym, mint] of [["WSOL", WSOL], ["USDC", USDC]]) {
    const b = bs58.decode(mint);
    for (let off = 0; off <= buf.length - 32; off++) {
      let ok = true;
      for (let i = 0; i < 32; i++) if (buf[off + i] !== b[i]) { ok = false; break; }
      if (ok) hits[sym] = off;
    }
  }
  // vaults owned by pool:
  const vaults = await rpcCall("getProgramAccounts", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", {
    encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: key } }], withContext: false,
  }]);
  const vaultInfo = [];
  for (const v of vaults) {
    const vb = Buffer.from(v.account.data[0], "base64");
    const mint = bs58.encode(vb.subarray(0, 32));
    const amt = vb.readBigUInt64LE(64);
    // find vault offset in pool
    const vbytes = bs58.decode(v.pubkey);
    let off = -1;
    for (let o = 0; o <= buf.length - 32; o++) {
      let ok = true;
      for (let i = 0; i < 32; i++) if (buf[o + i] !== vbytes[i]) { ok = false; break; }
      if (ok) { off = o; break; }
    }
    vaultInfo.push({ mint: mint === WSOL ? "WSOL" : mint === USDC ? "USDC" : mint.slice(0, 8), amount: amt.toString(), offset: off });
  }
  console.log(`\n${label} (len ${buf.length}): mint offsets=${JSON.stringify(hits)} vaults=${JSON.stringify(vaultInfo)}`);
  await sleep(600);
}
