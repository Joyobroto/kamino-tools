// memcmp@101+WSOL works (26K pools incl. Hp53XEtt), but memcmp@181+JitoSOL=0 even though
// Hp53XEtt literally has JitoSOL@181. HYPOSTHESIS: Helius memcmp 'bytes' has a LENGTH limit!
// WSOL base58 = 43 chars starting 'So11...'; JitoSOL = 44 chars 'J1toso...'.
// Solana memcmp bytes are limited to 29 BYTES encoded... base58 of 32-byte key = 43-44 chars — both over?
// No — standard memcmp accepts full pubkeys normally. BUT Helius V2/GPA on this endpoint...
// Test: shorten JitoSOL bytes to 43 chars (drop last char — memcmp is prefix-match on the encoded bytes):
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe";
// try prefix lengths:
for (const n of [44, 40, 32]) {
  try {
    const r = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 181, bytes: JITO.slice(0, n) } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
    console.log(`memcmp@181 prefix ${n}:`, r.length);
  } catch (e) { console.log(`prefix ${n} err:`, e.message.slice(0, 60)); }
}
