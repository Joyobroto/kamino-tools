// JUP program not in this ALT. Maybe numAddresses header offsets differ. Find ANY 32-byte run of
// known addresses. Search for the Manifest program or our wallet in the ALT:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
const j = await res.json();
const buf = Buffer.from(j.result.value.data[0], "base64");
// find u64 count fields that equal a plausible number and the tail length matches:
for (const off of [119, 123, 127, 131]) {
  const n = Number(buf.readBigUInt64LE(off));
  const remaining = buf.length - off - 8;
  if (n > 0 && remaining === n * 32) console.log(`count@${off} = ${n}, tail ${remaining} bytes = ${n}×32 ✓ ADDRESSES START @ ${off + 8}`);
}
// fallback: hexdump head:
for (let i = 0; i < 160; i += 32) console.log(String(i).padStart(3), buf.subarray(i, i + 32).toString("hex"));
