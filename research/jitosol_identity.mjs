// Identify the "JitoSOL" J1toso...GCPn: is it the real Jito LST or a clone?
// Real JitoSOL canonical mint (from Jito docs, widely known): J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe —
// which is GONE on-chain?! That can't be — JitoSOL is a top-10 asset. UNLESS my memory of the address
// is right and the getAccountInfo call failed for another reason (rate limit mid-loop earlier showed 'GONE').
// Re-check BOTH mints carefully now:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const [label, mint] of [
  ["canonical-memory", "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe"],
  ["jupiter-search ", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"],
]) {
  for (let a = 0; a < 3; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }) });
    if (res.status === 429) { await sleep(8000); continue; }
    const j = await res.json();
    const v = j.result?.value;
    const p = v?.data?.parsed?.info;
    console.log(`${label}: exists=${!!v} ${p ? `dec=${p.decimals} supply=${(Number(p.supply) / 10 ** p.decimals).toExponential(3)} mintAuth=${!!p.mintAuthority} freezeAuth=${!!p.freezeAuthority}` : ""}`);
    console.log(`  raw owner=${v?.owner}`);
    break;
  }
  await sleep(3000);
}
