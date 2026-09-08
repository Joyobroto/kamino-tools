// Script stopped after first (rate limits). Continue for the remaining LSTs, slower + targeted:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 8; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { console.error("rpc 429"); await sleep(10000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
async function geckoTopPool(query) {
  for (let a = 0; a < 6; a++) {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const pools = ((await res.json()).data ?? []).filter(p => p.id.startsWith("solana_"));
      pools.sort((a, b) => Number(b.attributes.reserve_in_usd || 0) - Number(a.attributes.reserve_in_usd || 0));
      return pools[0]?.attributes.address ?? null;
    }
    if (res.status === 429) { console.error("gecko 429"); await sleep(10000); continue; }
  }
  return null;
}
const WSOL = bs58.decode("So11111111111111111111111111111111111111112");
for (const [sym, q] of [["JupSOL", "JupSOL SOL"], ["mSOL", "mSOL SOL"], ["bSOL", "bSOL SOL"], ["INF", "Infinity SOL sanctum"]]) {
  await sleep(5000);
  const pool = await geckoTopPool(q);
  if (!pool) { console.log(`${sym}: no pool found`); continue; }
  console.log(`\n${sym}: top pool ${pool}`);
  const info = await call("getAccountInfo", [pool, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  // collect candidate 32-byte windows that look like mint addresses (not WSOL, not all-zero)
  const cands = [];
  for (let off = 0; off <= buf.length - 32; off += 1) {
    const w = buf.subarray(off, off + 32);
    if (w.equals(WSOL)) continue;
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0) continue;
    const a = bs58.encode(w);
    if (a.startsWith("1111") && a.length === 43) continue; // system-program-looking
    cands.push({ off, a });
  }
  // probe each candidate: is it a mint? (limit 8 probes)
  let found = 0;
  for (const c of cands) {
    if (found >= 3) break;
    try {
      const mi = await call("getAccountInfo", [c.a, { encoding: "jsonParsed" }]);
      const p = mi.value?.data?.parsed?.info;
      if (p && p.decimals !== undefined && p.supply && Number(p.supply) > 1e6) {
        console.log(`  ↳ @${c.off} MINT ${c.a} dec=${p.decimals} supply=${(Number(p.supply) / 10 ** p.decimals).toExponential(2)}`);
        found++;
      }
    } catch {}
    await sleep(800);
  }
}
