// Verify SPL mint layout decimals offset: mintAuthorityOption(4)+mintAuthority(32)+supply(8)=44 → decimals@44
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
for (const [name, mint] of [["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"], ["WSOL", "So11111111111111111111111111111111111111112"], ["ANB", "FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj"]]) {
  const info = await rpcCall("getAccountInfo", [mint, { encoding: "base64" }]);
  const buf = Buffer.from(info.value.data[0], "base64");
  console.log(name, "decimals@44:", buf[44], "(expect 6,9,6) mintAuthOption@0:", buf.readUInt32LE(0));
}
