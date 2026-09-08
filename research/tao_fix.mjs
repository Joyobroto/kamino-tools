// WrongSize: jsonParsed encoding for getTokenAccountsByOwner must be inside config as {encoding:"jsonParsed"}
// — it IS. The issue: Helius wants the config differently? Use base64 + manual parse instead.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpcCall(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(4000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited out");
}
// test both encodings quickly on the famous Orca pool
const tests = [
  ["jsonParsed nested", "getTokenAccountsByOwner", ["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP" }, { encoding: "jsonParsed" }]],
  ["base64 nested", "getTokenAccountsByOwner", ["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP" }, { encoding: "base64" }]],
];
for (const [name, method, params] of tests) {
  try {
    const r = await rpcCall(method, params);
    console.log(name, "OK →", r.value.length, "accounts");
  } catch (e) { console.log(name, "ERR:", e.message.slice(0, 60)); }
}
