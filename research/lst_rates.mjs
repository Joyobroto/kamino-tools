// LST redemption rates: where to read them?
// JitoSOL: rate = total lamports staked / JitoSOL supply. Rate account: "Jito4APyf642JZkfoVue1dLd2mM6VtbYm5j8ZZK2aKr" program...
// The simplest RELIABLE source: Jupiter price API v3 (price of LST vs SOL)! But oracle-dependent.
// BETTER for arb truth: Sanctum's LST list API: https://api.sanctum.xyz/v1/lsts
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
// Probe Sanctum API (LST rates):
try {
  const res = await fetch("https://api.sanctum.xyz/v1/lsts", { headers: { Accept: "application/json" } });
  console.log("sanctum lsts status:", res.status);
  if (res.ok) {
    const j = await res.json();
    const lsts = j.lsts ?? j ?? [];
    console.log("count:", Array.isArray(lsts) ? lsts.length : "obj");
    const arr = Array.isArray(lsts) ? lsts : [];
    for (const l of arr.slice(0, 10)) console.log(" ", JSON.stringify({ symbol: l.symbol, mint: l.mint?.slice(0, 8), apr: l.apr, priceSol: l.priceSol ?? l.ticker?.priceSol }));
    if (arr[0]) console.log("keys:", Object.keys(arr[0]).join(","));
  }
} catch (e) { console.log("sanctum ERR", e.message.slice(0, 80)); }
