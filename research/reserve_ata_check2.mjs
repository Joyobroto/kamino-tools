import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const WALLET = "AcRF3Zu5imsshcy1pJ3hXt2MrMvUfdsF6eT3DXFU6re1";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const WSOL = "So11111111111111111111111111111111111111112";
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
import bs58 from "bs58";
const kit = await import("@solana/kit");
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhMpASfgMQLBV4hYsXhHtHjCgwm";
for (const [label, program] of [["SPL", SPL_TOKEN], ["Token-2022", T22]]) {
  for (const [mlabel, mint] of [["JitoSOL", JITO], ["WSOL", WSOL]]) {
    const [ata] = await kit.getProgramDerivedAddress({
      programAddress: kit.address(program),
      seeds: [bs58.decode(WALLET), bs58.decode(mint)],
    });
    const acc = await call("getAccountInfo", [ata.toString(), { encoding: "jsonParsed" }]);
    console.log(`${label} ${mlabel} ATA: ${ata.toString().slice(0, 14)}… exists=${!!acc.value}`);
    await sleep(1200);
  }
}
