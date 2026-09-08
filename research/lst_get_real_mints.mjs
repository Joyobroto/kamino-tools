// ALMOST ALL my from-memory LST mints are wrong (GONE/CLOSED = wrong addresses)!
// Only the empirically-found JitoSOL is real. Get the TRUE mints by reading them
// from KNOWN-GOOD pools (Gecko search gave: orca JitoSOL/SOL pool HcmuBRdb…).
// Method: for each LST symbol, search Gecko for its pool, then read mints from the pool on-chain.
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
async function geckoPools(query) {
  for (let a = 0; a < 4; a++) {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" } });
    if (res.ok) return (await res.json()).data ?? [];
    if (res.status === 429) { await sleep(8000); continue; }
  }
  return [];
}
const QUERIES = ["JitoSOL SOL", "JupSOL SOL", "mSOL SOL orca", "bSOL SOL", "stSOL SOL", "INF SOL"];
for (const q of QUERIES) {
  const pools = await geckoPools(q);
  // find solana pools with meaningful liq
  const sol = pools.filter(p => p.id.startsWith("solana_")).sort((a, b) => Number(b.attributes.reserve_in_usd || 0) - Number(a.attributes.reserve_in_usd || 0));
  console.log(`\n${q}: ${sol.length} solana pools; top:`);
  for (const p of sol.slice(0, 2)) console.log(`  ${p.attributes.address} ${p.attributes.name} dex=${p.relationships?.dex?.data?.id} liq=$${Math.round(Number(p.attributes.reserve_in_usd || 0))}`);
  const best = sol[0];
  if (!best) continue;
  const addr = best.attributes.address;
  const info = await call("getAccountInfo", [addr, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  // scan all 32-byte windows; identify the LST mint as the one that's NOT WSOL
  const WSOL = bs58.decode("So11111111111111111111111111111111111111112");
  const seen = new Set();
  for (let off = 0; off <= buf.length - 32; off++) {
    const w = buf.subarray(off, off + 32);
    if (w.equals(WSOL) || seen.has(off)) continue;
    const addr2 = bs58.encode(w);
    if (addr2.startsWith("1") && addr2.length > 40) continue; // PDA junk
    // try mint check
    try {
      const mi = await call("getAccountInfo", [addr2, { encoding: "jsonParsed" }]);
      const p = mi.value?.data?.parsed?.info;
      if (p && p.decimals !== undefined && p.supply && Number(p.supply) > 0) {
        console.log(`  ↳ offset ${off}: MINT ${addr2} dec=${p.decimals} supply=${(Number(p.supply) / 10 ** p.decimals).toExponential(3)}`);
      }
    } catch {}
    await sleep(400);
  }
}
