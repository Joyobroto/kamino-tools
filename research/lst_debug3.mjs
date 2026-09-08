import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { console.error("429…"); await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
// what program owns Hp53XEtt (Gecko "orca" JitoSOL/SOL)?
const info = await call("getAccountInfo", ["Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp", { encoding: "base64" }]);
console.log("Orca JitoSOL/SOL owner:", info.value?.owner, "size:", Buffer.from(info.value.data[0], "base64").length);
await sleep(3000);
// memcmp on that owner program, all sizes — find JitoSOL pools:
const owner = info.value.owner;
const rows = await call("getProgramAccountsV2", [owner, { encoding: "base64", filters: [{ memcmp: { offset: 101, bytes: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" } }], limit: 10000 }]);
const sizes = {};
for (const a of rows.accounts ?? []) sizes[a.account.space ?? a.account.data[0].length] = (sizes[a.account.space ?? a.account.data[0].length] ?? 0) + 1;
console.log("JitoSOL@101 matches by data size:", JSON.stringify(sizes));
