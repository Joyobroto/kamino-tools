// Give up on guessing — read the ACTUAL SPL layout from the activated on-chain program docs:
// AddressLookupTable (v1) serialization (anchor-less manual borsh):
//   0: u8 tag (=1)
//   1-32: id
//   33-64: owner
//   65-68: authority option (u32) [0 = none, 1 = some]
//   69-100: authority pubkey (if option)
//   101-108: lastExtendedSlotStartIndex? NO —
// FINAL REFERENCE (spl/address-lookup-table/state.rs):
//   impl: tag(1), id(32), owner(32), authority(COption=4+32), 
//   last_extended_slot(8), last_extended_slot_start_index(u8=1), deactivation_slot(8),
//   _padding(2)?, addresses_len(8), addresses...
// Compute: 1+32+32+36+8+1+8+2?+8 = 128 → matches H=128 hypothesis with n=235!
// Verify by decoding bytes@120 as u64 = should be 235:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
for (let a = 0; a < 5; a++) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["CYN8QfFfXEtMZZKppoNxQwuuqnZZKHfk9G6DzprNRjBS", { encoding: "base64" }] }) });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 10000)); continue; }
  const j = await res.json();
  const buf = Buffer.from(j.result.value.data[0], "base64");
  console.log("len:", buf.length);
  for (const off of [118, 119, 120, 121, 122, 123, 124, 125, 126, 127]) {
    const n = Number(buf.readBigUInt64LE(off));
    if (n === 235 || n === 234 || n === 236) console.log(`✓ off ${off}: n=${n}`);
  }
  // dump 100..140 for manual read:
  console.log(buf.subarray(100, 140).toString("hex"));
  break;
}
