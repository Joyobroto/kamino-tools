// Non-integer for all — because count u64 is INSIDE the header: dataLen = H + 8 + n*32 where H+8 ≡ 24 (mod 32)
// → H ∈ {16, 48, 80, 112, 144, ...}. For H=136+8=144: n=(7640-144)/32=234.5 no...
// Wait — standard ALT layout per SPL program source:
//   tag: u8 (1)
//   id: Pubkey (32)
//   owner: Pubkey (32)
//   authority: COption<Pubkey> (4 + 32)
//   lastExtendedSlotStartIndex: u16 (2)
//   lastExtendedSlot: u64 (8)
//   _padding: u64 (8)
//   deactivationSlot: u64 (8)  — wait, order per source: deactivationSlot BEFORE lastExtendedSlot?
// Actual (lookup_table/state.rs):
//   tag(1), id(32), owner(32), authority(4+32), deactivationSlot(u64 8), lastExtendedSlotStartIndex(u16 2), 
//   lastExtendedSlot(u64 8), padding(8), numAddresses(u64 8), addresses...
// total header = 1+32+32+36+8+2+8+8+8 = 135. But 7640-135=7505, /32 = 234.53 ✗.
// UNLESS dataLen includes rent padding? No, ALT data is exact.
// Let me just find numAddresses by scanning u64s at offsets 120..135 where count*(32)+off+8==7640:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
const j = await res.json();
const buf = Buffer.from(j.result.value.data[0], "base64");
for (let off = 100; off < 140; off++) {
  if (off + 8 > buf.length) break;
  const n = Number(buf.readBigUInt64LE(off));
  if (n > 50 && n < 400) console.log(`off ${off}: n=${n} → tail check: ${off}+8+${n}*32 = ${off + 8 + n * 32} vs len ${buf.length} ${off + 8 + n * 32 === buf.length ? "✓" : "✗"}`);
}
