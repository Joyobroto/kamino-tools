// Fixed: remove the buggy intermediate math, keep raw reads only
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
async function jupRef(baseMint, decimals) {
  const params = new URLSearchParams({ inputMint: baseMint, outputMint: "So11111111111111111111111111111111111111112", amount: String(10 ** decimals), slippageBps: "1000" });
  for (let a = 0; a < 4; a++) {
    const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
    if (res.status === 400) return null;
    if (res.status === 429) { await sleep(4000); continue; }
    if (!res.ok) continue;
    const q = await res.json();
    if (!q.outAmount || Number(q.outAmount) === 0) return null;
    return Number(q.outAmount) / 1e9;
  }
  return null;
}
const picks = JSON.parse(readFileSync("/tmp/opencode/recheck_picks.json", "utf8"));
const WSOL = "So11111111111111111111111111111111111111112";
for (const p of picks) {
  try {
    const accs = await call("getMultipleAccounts", [[p.poolAddress], { encoding: "base64" }]);
    const pool = accs.value[0];
    if (!pool) { console.log(`pool ${p.poolAddress.slice(0, 8)} gone/closed`); await sleep(1000); continue; }
    const buf = Buffer.from(pool.data[0], "base64");
    const mintA = bs58.encode(buf.subarray(43, 75));
    const mintB = bs58.encode(buf.subarray(75, 107));
    const vA = bs58.encode(buf.subarray(139, 171));
    const vB = bs58.encode(buf.subarray(171, 203));
    const [balA, balB, mintAInfo, mintBInfo] = await Promise.all([
      call("getAccountInfo", [vA, { encoding: "base64" }]).then(r => r.value ? Buffer.from(r.value.data[0], "base64").readBigUInt64LE(64) : 0n),
      call("getAccountInfo", [vB, { encoding: "base64" }]).then(r => r.value ? Buffer.from(r.value.data[0], "base64").readBigUInt64LE(64) : 0n),
      call("getAccountInfo", [mintA, { encoding: "base64" }]).then(r => r.value ? Buffer.from(r.value.data[0], "base64")[44] : 0),
      call("getAccountInfo", [mintB, { encoding: "base64" }]).then(r => r.value ? Buffer.from(r.value.data[0], "base64")[44] : 0),
    ]);
    const uiA = Number(balA) / 10 ** mintAInfo;
    const uiB = Number(balB) / 10 ** mintBInfo;
    const baseMint = mintA === WSOL ? mintB : mintA;
    const baseUi = mintA === WSOL ? uiB : uiA;
    const solUi = mintA === WSOL ? uiA : uiB;
    const priceNow = solUi / baseUi;
    const baseDec = mintA === WSOL ? mintBInfo : mintAInfo;
    const refNow = await jupRef(baseMint, baseDec);
    const ratioNow = refNow ? priceNow / refNow : null;
    const ageH = ((Date.now() - new Date(p.detectedAt)) / 3600000).toFixed(1);
    console.log(`\npool ${p.poolAddress.slice(0, 8)}… base=${baseMint.slice(0, 8)}… (${ageH}h after detect)`);
    console.log(`  at detect: pool=${p.poolPriceInSol.toExponential(3)} ref=${(p.referencePriceInSol ?? 0).toExponential(3)} ratio=${p.ratio.toFixed(3)}`);
    console.log(`  NOW      : pool=${priceNow.toExponential(3)} ref=${refNow ? refNow.toExponential(3) : "none"} ratio=${ratioNow ? ratioNow.toFixed(3) : "?"} | vault: ${baseUi.toExponential(2)} base + ${solUi.toFixed(1)} SOL`);
  } catch (e) { console.log(`pool ${p.poolAddress.slice(0, 8)} ERR ${e.message.slice(0, 80)}`); }
  await sleep(2000);
}
