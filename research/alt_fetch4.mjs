// No clean match → the ALT might be fetched with the ACTIVATED view (getAddressLookupTable RPC
// returns only active addresses; raw account includes inactive/deactivation fields).
// dataLen 7640: if header=135 then addresses=(7640-135)/32=234.5 — non-integer! So header≠135.
// Try (7640-131)/32 = 234.6 also no. 7640 = 8k? Find count near end-of-header possibilities:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
const j = await res.json();
const buf = Buffer.from(j.result.value.data[0], "base64");
console.log("len:", buf.length, "len%32 =", buf.length % 32, "→ header ≡", buf.length % 32, "mod 32");
// header must be len mod 32 + k*32: possible headers: 8, 40, 72, 104, 136, 168...
// try each: count = (len - h)/32 for h in [8,40,72,104,136,168,200]: all integers?
for (const h of [8, 40, 72, 104, 136, 168]) {
  const n = (buf.length - h) / 32;
  console.log(`header=${h} → ${n} addresses`);
}
