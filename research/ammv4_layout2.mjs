// Correct AMMv4 decode: layout = status(6) nonce(1) maxVelo(4) token0Vault(32) token1Vault(32)
// token0Mint(32) token1Mint(32) token0Dec(1) token1Dec(1) vaultSignerNonce(8) amtTarget0(8) amtTarget1(8)
// fees(8) ... then fees disc, swapInAmount, swapOutAmount... Let's decode properly:
// status 0..5, nonce 6, maxVelo 7..10, token0Vault 11..42, token1Vault 43..74, token0Mint 75..106,
// token1Mint 107..138, token0Dec 139, token1Dec 140, vaultSignerNonce 141..148, amtTarget0 149..156,
// amtTarget1 157..164, fees 165..172 (protocolFee0? actually { mintFee, protocolFee, fundFee } ...), then anchors.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await new Promise(r => setTimeout(r, 4000)); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited out");
}
const info = await rpcCall("getAccountInfo", ["B3c63dUHXcoMJbMMwZGcbJoGo2MdGNkpDnLH13jAMCBw", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
const S = (o) => bs58.encode(buf.subarray(o, o + 32));
const u64 = (o) => buf.readBigUInt64LE(o);
console.log("status       :", buf.subarray(0, 6).toString("hex"), "→", buf.subarray(0, 6).equals(Buffer.from([6,0,0,0,0,0])) ? "ENABLED(6)" : "other");
console.log("token0Vault :", S(11));
console.log("token1Vault :", S(43));
console.log("token0Mint  :", S(75));
console.log("token1Mint  :", S(107));
console.log("token0Dec   :", buf[139], " token1Dec:", buf[140]);
// fees: 8 bytes at 165 = { mintFee0? } per docs: fees: {mint_fee, protocol_fee, fund_fee, protocol_fees0, protocol_fees1} — hmm.
// The well-known constant-product state in AMMv4 begins after a "fees" struct: 
// layout offset: u64 nonce vault signer... Actually per raydium docs:
// ... token0Dec(1) token1Dec(1) vaultSignerNonce(8) amtTarget0(8) amtTarget1(8) fees{...}(8?) 
// then poolCoin, poolPc, feesTpCoin? — empirical approach: search for the two big u64s = reserves.
// Known: swapInAmount/swapOutAmount are u128. The reserves poolCoin/poolPc are u64.
// From hex dump at 192: 82a33ca301000000 = 5,463,811,714 u64 → plausible reserve. 127c... = 4724.
// 224: 6af1036800000000 = 4,310,756,774 → plausible.
// 256: fcf7f42259120000 = 3,214,830,922,300? → could be u128 part.
// Print candidates:
for (let off = 176; off <= 264; off += 8) console.log(`u64@${off}:`, u64(off).toString());
