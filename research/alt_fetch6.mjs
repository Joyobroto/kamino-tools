// Still no match. Screw layout guessing — read bytes 100..140 raw:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
const j = await res.json();
const buf = Buffer.from(j.result.value.data[0], "base64");
console.log("bytes 96..160:", buf.subarray(96, 160).toString("hex"));
// maybe this RPC returns the account with different data? check owner:
console.log("owner:", j.result.value.owner);
// owner should be AddressLookupTab1e1111111111111111111111111
