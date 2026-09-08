// "WrongSize" everywhere via raw fetch — but our TS repo code WORKS with @solana/kit.
// Difference: kit uses its own serialization? Let's test a MINIMAL raw call exactly as before but on Token program:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function raw(body) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
// 1) plain getTokenAccountBalance (worked earlier)
console.log("getTokenAccountBalance:", JSON.stringify(await raw({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: ["111KS1WpmX47fNW8ZRXbC2UW4CsPFmXhyvPYtA6vCP"] })).slice(0, 120));
// 2) getProgramAccounts on Token program WITH filters (dataSize 165 + memcmp):
const j2 = await raw({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP", { encoding: "base64", filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" } }] }] });
console.log("GPA token filter:", j2.error ? `ERR ${j2.error.message.slice(0, 100)}` : `OK ${(j2.result ?? []).length}`);
// 3) maybe dataSize must be first / memcmp bytes must be shorter? try dataSize only:
const j3 = await raw({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP", { encoding: "base64", filters: [{ dataSize: 165 }] }] });
console.log("GPA dataSize only:", j3.error ? `ERR ${j3.error.message.slice(0, 100)}` : `OK ${(j3.result ?? []).length} (huge?)`);
