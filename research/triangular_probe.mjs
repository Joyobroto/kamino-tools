// TRIANGULAR RESEARCH: vault-truth cross-venue round-trips for major meme tokens.
// Method (all from live vault balances, no aggregator quotes):
//   cycle: USDC --(pool A: USDC/TOKEN)--> TOKEN --(pool B: TOKEN/SOL)--> SOL --(pool C: SOL/USDC)--> USDC
//   price each pool via constant-product on the trade size (real slippage), compare output vs input.
// We reuse the verified venue layouts from src/strategies/arb/venues.ts.
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

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// verified layouts (offsets): {size, mintA, mintB, vaultA, vaultB}
const VENUES = [
  { name: "meteora-damm", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", size: 904, mA: 88, mB: 120, vA: 152, vB: 184 },
  { name: "orca-whirlpool", program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", size: 653, mA: 101, mB: 181, vA: 133, vB: 213 },
];

// scan a venue for pools containing BOTH USDC or WSOL plus a given token
async function findPools(tokenMint) {
  const tokenBytes = bs58.decode(tokenMint);
  const found = [];
  for (const v of VENUES) {
    let key = null;
    do {
      const page = await call("getProgramAccountsV2", [v.program, {
        encoding: "base64", filters: [{ dataSize: v.size }],
        dataSlice: { offset: Math.min(v.mA, v.mB), length: Math.abs(v.mB - v.mA) + 32 }, limit: 10000,
        ...(key ? { paginationKey: key } : {}),
      }]);
      for (const a of page.accounts ?? []) {
        const buf = Buffer.from(a.account.data[0], "base64");
        const off1 = v.mA - Math.min(v.mA, v.mB);
        const off2 = v.mB - Math.min(v.mA, v.mB);
        const mintA = bs58.encode(buf.subarray(off1, off1 + 32));
        const mintB = bs58.encode(buf.subarray(off2, off2 + 32));
        if (mintA === tokenMint || mintB === tokenMint) found.push({ venue: v, address: a.pubkey, mintA, mintB });
      }
      key = page.paginationKey;
    } while (key);
    await sleep(1000);
  }
  return found;
}

// price a constant-product pool at a given input size (out = y*x_in/(x+y_in) with fee 0)
function cpmmOut(reserveIn, reserveOut, amountIn) {
  const k = reserveIn * reserveOut;
  const newIn = reserveIn + amountIn;
  return k / newIn;
}

async function pricePool(poolEntry, tokenMint) {
  const v = poolEntry.venue;
  const info = await call("getAccountInfo", [poolEntry.address, { encoding: "base64" }]);
  if (!info.value) return null;
  const buf = Buffer.from(info.value.data[0], "base64");
  if (buf.length !== v.size) return null;
  const vA = bs58.encode(buf.subarray(v.vA, v.vA + 32));
  const vB = bs58.encode(buf.subarray(v.vB, v.vB + 32));
  const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "base64" }]);
  const parse = (acc) => {
    if (!acc?.value) return null;
    const b = Buffer.from(acc.value.data[0], "base64");
    if (b.length !== 165) return null;
    return b.readBigUInt64LE(64);
  };
  const rawA = parse(bals.value[0]), rawB = parse(bals.value[1]);
  if (rawA === null || rawB === null || rawA <= 0n || rawB <= 0n) return null;
  const mints = await call("getMultipleAccounts", [[poolEntry.mintA, poolEntry.mintB], { encoding: "base64" }]);
  const dec = (acc) => acc?.value ? Buffer.from(acc.value.data[0], "base64")[44] : null;
  const dA = dec(mints.value[0]), dB = dec(mints.value[1]);
  if (dA === null || dB === null) return null;
  return {
    address: poolEntry.address,
    venue: v.name,
    mintA: poolEntry.mintA, mintB: poolEntry.mintB,
    uiA: Number(rawA) / 10 ** dA, uiB: Number(rawB) / 10 ** dB,
    decA: dA, decB: dB,
    rawA: rawA.toString(), rawB: rawB.toString(),
  };
}

// --- run for BONK (canonical multi-venue meme) ---
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
console.log("scanning pools for BONK...");
const pools = await findPools(BONK);
console.log("BONK pools found:", pools.length);
const usdcPools = [], solPools = [];
for (const p of pools) {
  const other = p.mintA === BONK ? p.mintB : p.mintA;
  const priced = await pricePool(p, BONK);
  if (!priced) continue;
  if (other === USDC && priced.uiA * 1 > 0) usdcPools.push({ ...priced, side: other, usdDepth: other === USDC ? (p.mintA === USDC ? priced.uiA : priced.uiB) : null });
  if (other === WSOL) solPools.push({ ...priced, side: other });
  await sleep(800);
}
console.log("USDC pairs:", usdcPools.length, "| SOL pairs:", solPools.length);
for (const p of usdcPools) console.log(`  USDC pool ${p.venue} ${p.address.slice(0, 8)}: ${(p.mintA === USDC ? p.uiA : p.uiB).toExponential(2)} USDC + ${(p.mintA === BONK ? p.uiA : p.uiB).toExponential(2)} BONK`);
for (const p of solPools) console.log(`  SOL pool ${p.venue} ${p.address.slice(0, 8)}: ${(p.mintA === WSOL ? p.uiA : p.uiB).toExponential(2)} SOL + ${(p.mintA === BONK ? p.uiA : p.uiB).toExponential(2)} BONK`);
