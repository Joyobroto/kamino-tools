import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const WALLET = "AcRF3Zu5imsshcy1pJ3hXt2MrMvUfdsF6eT3DXFU6re1";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
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
// 1) Kamino JitoSOL reserve mint + token program (from earlier reserves scan: EVbyPKrH…jKsktW)
// get reserve account and read its liquidity fields:
const info = await call("getAccountInfo", ["EVbyPKrHvfxPKVs4d3Lhv NZkHV7GbvnzfJs7jKsktW".replace(" ", ""), { encoding: "base64" }]);
console.log("reserve account exists:", !!info.value);
// Instead derive both possible ATAs (SPL vs Token2022) and see which exists / which the wallet uses:
// SPL ATA:
import bs58 from "bs58";
async function findProgramAddressSeeds(seeds, programId) {
  // brute-force off-chain PDA (bump 255→0):
  const { createHash } = await import("node:crypto");
  for (let bump = 255; bump >= 0; bump--) {
    const data = Buffer.concat([...seeds.map(s => Buffer.from(s)), Buffer.from([bump]), bs58.decode(programId)]);
    const hash = createHash("sha256").update(Buffer.concat([Buffer.from("ProgramDerivedAddress"), data])).digest();
    // check if hash is on curve (skip full check — use point decode):
    if (!isOnCurve(hash)) return { pda: bs58.encode(hash), bump };
  }
  return null;
}
function isOnCurve(bytes) {
  // y^2 = x^3 + 7 (secp256k1? NO — Solana uses ed25519 curve: -x^2+y^2=1+(1518...)x^2y^2)
  // Implementing ed25519 on-curve check: use @solana/kit isBytesOnCurve if available:
  return null; // placeholder
}
// USE kit instead:
const kit = await import("@solana/kit");
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhMpASfgMQLBV4hYsXhHtHjCgwm";
for (const [label, program] of [["SPL", SPL_TOKEN], ["Token-2022", T22]]) {
  const [ata] = await kit.getProgramDerivedAddress({
    programAddress: kit.address(program),
    seeds: [new TextEncoder().encode(WALLET), bs58.decode(JITO)],
  });
  console.log(`${label} ATA for JitoSOL:`, ata.toString());
  const acc = await call("getAccountInfo", [ata.toString(), { encoding: "jsonParsed" }]);
  console.log(`  exists:`, !!acc.value);
  await sleep(1500);
}
