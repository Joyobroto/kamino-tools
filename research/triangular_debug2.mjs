import { readFileSync } from "node:fs";
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
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCaBRiWmHQxjC4tDgWi";
const info = await call("getAccountInfo", [BONK, { encoding: "jsonParsed" }]);
console.log("BONK mint exists:", !!info.value, info.value?.data?.parsed?.info ? `dec=${info.value.data.parsed.info.decimals}` : "");
// also: which venues actually have big BONK liquidity? From our knowledge: Raydium AMMv4 + Orca.
// Raydium AMMv4 vaults are PDA-derived (excluded from our venues list!) — that's why 0 found.
// Orca whirlpool layout mints are @101/@181 — check one known BONK whirlpool via search later.
