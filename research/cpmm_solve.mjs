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
// find a CPMM pool with real balances: take first few 637-byte accounts
const res = await rpcCall("getProgramAccounts", ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", {
  encoding: "base64", filters: [{ dataSize: 637 }], dataSlice: { offset: 0, length: 0 }, withContext: false,
}]);
console.log("CPMM accounts:", res.length);
for (const r of res.slice(0, 5)) {
  const info = await rpcCall("getAccountInfo", [r.pubkey, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  // try candidate vault offsets from Raydium CPMM IDL: authority@40? token0Vault@40? IDL says:
  // disc(8) authority(32)@8, authorityBump(1)@40, bumpArray(2)@41, token0Vault(32)@43, token1Vault(32)@75,
  // vaultMint?(32)@107?, token0Mint@139?? Let's brute: read pubkeys at 43/75 and check token accounts:
  const cands = {};
  for (const off of [43, 75, 107, 139, 171]) {
    const v = bs58.encode(buf.subarray(off, off + 32));
    try {
      const bal = await rpcCall("getTokenAccountBalance", [v]);
      cands[off] = { acct: v.slice(0, 8), bal: bal.value.uiAmountString, dec: bal.value.decimals };
    } catch { cands[off] = null; }
  }
  const good = Object.entries(cands).filter(([, x]) => x);
  if (good.length >= 2) {
    console.log("pool:", r.pubkey, JSON.stringify(good));
    // find mints for the two vaults:
    for (const [off, x] of good) {
      const info2 = await rpcCall("getAccountInfo", [x.acct ? bs58.encode(buf.subarray(Number(off), Number(off) + 32)) : "", { encoding: "base64" }]);
    }
    break;
  }
  await sleep(400);
}
