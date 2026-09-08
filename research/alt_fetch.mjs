// Fetch the JUP ALT and parse addresses; verify our wallet-relevant accounts are in it.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
const j = await res.json();
const buf = Buffer.from(j.result.value.data[0], "base64");
console.log("ALT data len:", buf.length);
const numAddresses = buf.readBigUInt64LE(127); // after: tag1 id32 owner32 authority36 lastExtendedSlotStartIndex2? — let's locate by searching for a known member: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
const jupBytes = bs58.decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
let foundAt = -1;
for (let off = 135; off <= buf.length - 32; off++) {
  let ok = true;
  for (let i = 0; i < 32; i++) if (buf[off + i] !== jupBytes[i]) { ok = false; break; }
  if (ok) { foundAt = off; break; }
}
console.log("JUP program found at offset:", foundAt);
if (foundAt > 0) {
  const start = foundAt;
  console.log("addresses begin at:", start, "→ count:", (buf.length - start) / 32);
  console.log("header len matches 135?", start === 135);
}
