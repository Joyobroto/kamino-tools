// $3691 profit still absurd. Inspect 8QaXeHBr and BqnpCdDL + verify CPMM math on the REAL BONK pools.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
for (const prefix of ["8QaXeHBr", "BqnpCdDL"]) {
  let key = null;
  do {
    const page = await call("getProgramAccountsV2", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", {
      encoding: "base64", filters: [{ dataSize: 653 }], dataSlice: { offset: 101, length: 112 }, limit: 10000, ...(key ? { paginationKey: key } : {}),
    }]);
    for (const a of page.accounts ?? []) {
      if (!a.pubkey.startsWith(prefix)) continue;
      const info = await call("getAccountInfo", [a.pubkey, { encoding: "base64" }]);
      const buf = Buffer.from(info.value.data[0], "base64");
      const mintA = bs58.encode(buf.subarray(101, 133));
      const mintB = bs58.encode(buf.subarray(181, 213));
      const vA = bs58.encode(buf.subarray(133, 165));
      const vB = bs58.encode(buf.subarray(213, 245));
      const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "jsonParsed" }]);
      const pA = bals.value[0]?.data?.parsed?.info;
      const pB = bals.value[1]?.data?.parsed?.info;
      console.log(`\nwhirlpool ${a.pubkey}`);
      console.log(`  mintA=${mintA === BONK ? "BONK" : mintA === USDC ? "USDC" : mintA === WSOL ? "WSOL" : mintA.slice(0, 10)}`);
      console.log(`  mintB=${mintB === BONK ? "BONK" : mintB === USDC ? "USDC" : mintB === WSOL ? "WSOL" : mintB.slice(0, 10)}`);
      console.log(`  vaultA ${pA?.mint?.slice(0, 8)} ${pA?.tokenAmount?.uiAmountString}`);
      console.log(`  vaultB ${pB?.mint?.slice(0, 8)} ${pB?.tokenAmount?.uiAmountString}`);
      // CRITICAL: whirlpools are CONCENTRATED — vault ratio ≠ price! print tick info if available:
      // (liquidity is binned; a $1000 trade in an out-of-range pool produces fantasy rates)
      console.log(`  ⚠ whirlpool = concentrated liquidity; vault-ratio pricing is INVALID here`);
    }
    key = page.paginationKey;
  } while (key);
  await sleep(3000);
}
