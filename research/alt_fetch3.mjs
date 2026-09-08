// Layout clearer from dump: tag@0=1, id@1..33, owner@33..65, authority@65..97 (COption: 4 bytes @65..69 = 0xffffffff (none) + padding?), 
// Then @69..77 lastExtendedSlot? etc. Let's find count: @ 0x10=16: f460d11600000000 = 0x16d160f4 = slot ✓! So:
// tag(1) id(32)@1 owner(32)@33 COption authority: 4+32 → @65..101; lastExtendedSlotStartIndex u16 @101..103? 
// from dump @64: ef45b324 777e7f26 → part of authority; @96: 0257851a c9193614 ... → lastExtendedSlot area.
// Simpler: search for the length field = (dataLen-135)/32? try scanning every offset for u64 n where (len - off - 8) == n*32:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
const j = await res.json();
const buf = Buffer.from(j.result.value.data[0], "base64");
const len = buf.length;
for (let off = 0; off < 200; off += 1) {
  const n = Number(buf.readBigUInt64LE(off));
  if (Number.isInteger(n) && n > 10 && n < 1000 && len - off - 8 === n * 32) {
    console.log(`match at offset ${off}: count=${n}`);
  }
}
