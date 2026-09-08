// "WrongSize" on getTokenAccountsByOwner — maybe Helius variant needs the filter WITHOUT programId object?
// Test variations:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function raw(body) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
const owner = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP";
const tests = [
  ["mint+program object", { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { programId: TOKEN }, { encoding: "base64" }] }],
  ["string program", { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, TOKEN, { encoding: "base64" }] }],
  ["jsonParsed flat", { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { programId: TOKEN }, { encoding: "jsonParsed", commitment: "confirmed" }] }],
];
for (const [name, body] of tests) {
  const j = await raw(body);
  console.log(name, "→", j.error ? `ERR ${j.error.message.slice(0, 60)}` : `OK ${j.result.value.length}`);
}
