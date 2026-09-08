// AMMv4 canonical layout from raydium-amm source (anchor state):
// status(6) nonce(1) maxVelo(4) token0Vault(32) token1Vault(32) token0Mint(32) token1Mint(32)
// token0Decimals(1) token1Decimals(1) vaultSignerNonce(8) amtTarget0(8) amtTarget1(8)
// fees: { mintFee(4)? ... } — anchor Fees struct = u64 total? Actually:
//   Fees {mint_fee: u64, protocol_fee: u64, fund_fee: u64, protocol_fees0: u64, protocol_fees1: u64} = 40 bytes
// Then: u64 feesToken0? No — classic layout continues:
//   u64 token0ProgramFee? Let me use KNOWN anchor IDL offsets from raydium-amm:
// state = { status, nonce, maxVelo, token0Vault, token1Vault, token0Mint, token1Mint,
//           token0Decimals, token1Decimals, vaultSignerNonce, amtTarget0, amtTarget1,
//           fees: Fees, feesDisc(?)..., swapInAmount: u128, swapOutAmount: u128,
//           poolCoin: u64, poolPc: u64, ... }
// offsets: status0(6) nonce6(1) maxVelo7(4) vault0@11 vault1@43 mint0@75 mint1@107
// dec0@139 dec1@140 signerNonce@141(8) amtTarget0@149(8) amtTarget1@157(8)
// fees@165: mint_fee(8) protocol_fee(8) fund_fee(8) protocol_fees0(8) protocol_fees1(8) → ends @205
// pendingFees? there are more fields: feesAccount, needTakePnlCoin(8) needTakePnlPc(8) 
// then swapInAmount(16) swapOutAmount(16) poolCoin(8) poolPc(8) poolLpToken(8)
// Actually let's test with u128 candidates:
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
const u64 = (o) => buf.readBigUInt64LE(o);
const u128 = (o) => buf.readBigUInt64LE(o) | (buf.readBigUInt64LE(o + 8) << 64n);
// Known AMMv4 layout (from raydium-amm IDL, offsets verified in many MEV bots):
// ... swapInAmount@165? Let's check: fees fields per IDL: Fees{mint_fee u64, protocol_fee u64, fund_fee u64, protocol_fees0 u64, protocol_fees1 u64} = 40 bytes @165→205
// feesAccount(32) @205→237, needTakePnlCoin(8) @237, needTakePnlPc(8) @245,
// swapInAmount u128 @253?? — hexdump showed values at 192,224,256...
// Try alternate: after fees@165(40) → feesAccount@205(32) → needTakePnlCoin@237(8) → needTakePnlPc@245(8)
// → swapInAmount@253(16) → swapOutAmount@269(16) → poolCoin@285(8) → poolPc@293(8) → poolLpToken@301(8)
console.log("attempt A offsets:");
console.log("  needTakePnlCoin@237:", u64(237).toString());
console.log("  needTakePnlPc@245:", u64(245).toString());
console.log("  swapInAmount@253:", u128(253).toString());
console.log("  swapOutAmount@269:", u128(269).toString());
console.log("  poolCoin@285:", u64(285).toString());
console.log("  poolPc@293:", u64(293).toString());
console.log("  poolLpToken@301:", u64(301).toString());
// cross-check vault balances:
const S = (o) => bs58.encode(buf.subarray(o, o + 32));
const v0 = S(11), v1 = S(43);
for (const v of [v0, v1]) {
  const bal = await rpcCall("getTokenAccountBalance", [v]);
  console.log("vault", v.slice(0, 8), "balance:", bal.value.amount, "dec:", bal.value.decimals);
}
