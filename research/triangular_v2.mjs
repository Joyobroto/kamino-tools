// TRIANGULAR RESEARCH v2: batched vault pricing for BONK pools (2 venues).
// Cycle: USDC ->BONK (USDC pool) -> SOL (WSOL pool) -> USDC (SOL/USDC pool, fixed ref)
// All prices = constant-product executable at chosen size (real slippage).
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { console.error("429…"); await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const VENUES = [
  { name: "meteora-damm", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", size: 904, mA: 88, mB: 120, vA: 152, vB: 184 },
  { name: "orca-whirlpool", program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", size: 653, mA: 101, mB: 181, vA: 133, vB: 213 },
];

// 1) slice-scan both venues once, collect BONK pool candidates
const candidates = [];
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
      const off1 = v.mA - Math.min(v.mA, v.mB), off2 = v.mB - Math.min(v.mA, v.mB);
      const mintA = bs58.encode(buf.subarray(off1, off1 + 32));
      const mintB = bs58.encode(buf.subarray(off2, off2 + 32));
      if (mintA === BONK || mintB === BONK) candidates.push({ venue: v, address: a.pubkey, mintA, mintB });
    }
    key = page.paginationKey;
  } while (key);
  await sleep(2000);
}
console.log("BONK pools:", candidates.length);
const usdcCands = candidates.filter(c => c.mintA === USDC || c.mintB === USDC);
const solCands = candidates.filter(c => c.mintA === WSOL || c.mintB === WSOL);
console.log("USDC pairs:", usdcCands.length, "| SOL pairs:", solCands.length);

// 2) batched vault+pool fetch for candidates (only the pairs we need)
async function priceAll(cands, label) {
  const priced = [];
  const CHUNK = 80;
  for (let i = 0; i < cands.length; i += CHUNK) {
    const slice = cands.slice(i, i + CHUNK);
    const infos = await call("getMultipleAccounts", [slice.map(c => c.address), { encoding: "base64" }]);
    // collect vault addresses
    const vaults = [];
    for (const [j, c] of slice.entries()) {
      const acc = infos.value[j];
      const buf = acc ? Buffer.from(acc.data[0], "base64") : null;
      if (!buf || buf.length !== c.venue.size) { vaults.push(null); continue; }
      const v = c.venue;
      vaults.push([bs58.encode(buf.subarray(v.vA, v.vA + 32)), bs58.encode(buf.subarray(v.vB, v.vB + 32))]);
    }
    const flatVaults = vaults.filter(Boolean).flat();
    const vBals = await call("getMultipleAccounts", [flatVaults, { encoding: "base64" }]);
    const balMap = new Map();
    let idx = 0;
    for (const pair of vaults) {
      if (!pair) continue;
      for (const addr of pair) { balMap.set(addr, vBals.value[idx]); idx += 1; }
    }
    for (const [j, c] of slice.entries()) {
      const pair = vaults[j];
      if (!pair) continue;
      const [bA, bB] = [balMap.get(pair[0]), balMap.get(pair[1])];
      if (!bA || !bB) continue;
      const rawA = Buffer.from(bA.data[0], "base64").readBigUInt64LE(64);
      const rawB = Buffer.from(bB.data[0], "base64").readBigUInt64LE(64);
      if (rawA <= 0n || rawB <= 0n) continue;
      priced.push({ venue: c.venue.name, address: c.address, mintA: c.mintA, mintB: c.mintB, rawA, rawB });
    }
    await sleep(1500);
  }
  console.log(`priced ${label}: ${priced.length}`);
  return priced;
}

const usdcPools = await priceAll(usdcCands, "USDC-pairs");
const solPools = await priceAll(solCands, "SOL-pairs");
// also decimals for BONK(5? 6?)/USDC(6)/SOL(9) from mints:
const mintInfo = await call("getMultipleAccounts", [[BONK, USDC, WSOL], { encoding: "base64" }]);
const dec = {};
dec[BONK] = Buffer.from(mintInfo.value[0].data[0], "base64")[44];
dec[USDC] = Buffer.from(mintInfo.value[1].data[0], "base64")[44];
dec[WSOL] = Buffer.from(mintInfo.value[2].data[0], "base64")[44];
console.log("decimals:", JSON.stringify(dec));

// 3) triangular cycle evaluation at $1000:
function cpOut(rawIn, rawOut, amountInRaw) {
  const x = Number(rawIn), y = Number(rawOut);
  const amountIn = Number(amountInRaw);
  if (!(amountIn > 0)) return 0;
  return BigInt(Math.floor((y * amountIn) / (x + amountIn))); // raw units out
}
const SIZE_USDC = 1000;
const sizeRaw = BigInt(Math.floor(SIZE_USDC * 10 ** dec[USDC]));
const SOL_USDC_REFS = [ // biggest SOL/USDC pools (both venues) for leg 3; get from orca/met pools? use meteora-damm SOL/USDC found earlier: 5rCf1DM8 (meteora-damm)
  { venue: "meteora-damm", address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", mA: 88, mB: 120, vA: 152, vB: 184 },
];
// price leg3 pool (SOL->USDC) once:
const leg3 = SOL_USDC_REFS[0];
const leg3info = await call("getAccountInfo", [leg3.address, { encoding: "base64" }]);
const l3buf = Buffer.from(leg3info.value.data[0], "base64");
const l3vA = bs58.encode(l3buf.subarray(leg3.vA, leg3.vA + 32));
const l3vB = bs58.encode(l3buf.subarray(leg3.vB, leg3.vB + 32));
const l3bals = await call("getMultipleAccounts", [[l3vA, l3vB], { encoding: "base64" }]);
const l3rawA = Buffer.from(l3bals.value[0].data[0], "base64").readBigUInt64LE(64);
const l3rawB = Buffer.from(l3bals.value[1].data[0], "base64").readBigUInt64LE(64);
const l3mintA = bs58.encode(l3buf.subarray(leg3.mA, leg3.mA + 32));
const l3mintB = bs58.encode(l3buf.subarray(leg3.mB, leg3.mB + 32));
console.log(`leg3 pool: ${l3mintA.slice(0, 6)}/${l3mintB.slice(0, 6)} ${(Number(l3rawA) / 1e9).toFixed(0)} ${(Number(l3rawB) / 1e6).toFixed(0)}`);

// Depth filter: the QUOTE side (USDC in pool A, SOL in pool B) must actually hold
// the amounts the cycle extracts — ghost pools (1.4B BONK vs $150 USDC) produce
// mathematically "profitable" cycles that revert on-chain.
const MIN_QUOTE_USDC = 1500; // > $1000 trade size
const MIN_QUOTE_SOL = 6;
const deepUsdc = usdcPools.filter(p => {
  const usdcRaw = p.mintA === BONK ? p.rawB : p.rawA;
  return Number(usdcRaw) / 10 ** 6 >= MIN_QUOTE_USDC;
});
const deepSol = solPools.filter(p => {
  const solRaw = p.mintA === BONK ? p.rawB : p.rawA;
  return Number(solRaw) / 1e9 >= MIN_QUOTE_SOL;
});
console.log(`deep pools: USDC ${deepUsdc.length}/${usdcPools.length}, SOL ${deepSol.length}/${solPools.length}`);

let best = null;
for (const up of deepUsdc) {
  const isBONKinA = up.mintA === BONK;
  const bonkRaw = isBONKinA ? up.rawA : up.rawB;
  const usdcRaw = isBONKinA ? up.rawB : up.rawA;
  if (bonkRaw <= 0n || usdcRaw <= 0n) continue;
  // leg1: USDC -> BONK
  const bonkOut = cpOut(usdcRaw, bonkRaw, sizeRaw);
  if (bonkOut <= 0) continue;
  for (const sp of deepSol) {
    const isBONKinA2 = sp.mintA === BONK;
    const bonkRaw2 = isBONKinA2 ? sp.rawA : sp.rawB;
    const solRaw = isBONKinA2 ? sp.rawB : sp.rawA;
    // leg2: BONK -> SOL (input in BONK raw)
    const solOutRaw = cpOut(bonkRaw2, solRaw, bonkOut);
    if (solOutRaw <= 0) continue;
    // leg3: SOL -> USDC
    const usdcOutRaw = cpOut(l3mintA === WSOL ? l3rawA : l3rawB, l3mintA === WSOL ? l3rawB : l3rawA, solOutRaw);
    const usdcOut = Number(usdcOutRaw) / 10 ** dec[USDC];
    const profit = usdcOut - SIZE_USDC;
    if (profit > 0 || (best && profit > best.profit)) {
      if (!best || profit > best.profit) {
        best = { profit, up: up.address.slice(0, 8), upv: up.venue, sp: sp.address.slice(0, 8), spv: sp.venue, bonkOut, solOut: Number(solOutRaw) / 1e9, usdcOut };
      }
    }
  }
}
console.log("\n=== BEST TRIANGULAR CYCLE (USDC->BONK->SOL->USDC @ $1000) ===");
if (best && best.profit > 0) {
  console.log(`PROFIT: $${best.profit.toFixed(4)}`);
  console.log(`USDC->BONK via ${best.upv} ${best.up} | BONK->SOL via ${best.spv} ${best.sp}`);
  console.log(`SOL out: ${best.solOut.toFixed(6)} | USDC out: ${best.usdcOut.toFixed(2)}`);
} else {
  console.log(best ? `best cycle: $${best.profit.toFixed(4)} (NEGATIVE — no arb at $1000)` : "no cycle computable");
}
