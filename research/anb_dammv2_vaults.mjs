// DAMMv2 layout: mints @168/@200. Vault PDAs come after. Find vault pubkeys and their balances.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const poolB = "Ee8hN27zmvpkX4LimkuYz5UmjyNv2Vc1XbCvyvyohmfp";
const info = await rpcCall("getAccountInfo", [poolB, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
// DAMMv2 pool state layout (from meteora-damm-v2 IDL): 
// ... padding(64) then bump(1) ... Let's hexdump 0..600 to find plausible vault keys + u128 reserves:
for (let i = 0; i < 320; i += 32) console.log(String(i).padStart(4), buf.subarray(i, i + 32).toString("hex"));
console.log("mints at 168/200 confirmed");
// try: vault0@232, vault1@264?
const S = (o) => bs58.encode(buf.subarray(o, o + 32));
for (const off of [232, 264, 296, 328, 360, 392]) {
  const v = S(off);
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`candidate vault @${off}: ${v} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`candidate vault @${off}: ${v} → not a token account`); }
}
