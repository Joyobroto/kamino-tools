// Eo7WjKq (944B) — JitoSOL/SOL pool: WSOL@40 found, but no vault pubkeys of pool-owned token accts inside.
// Find JitoSOL mint offset + vault candidates by hexdumping head + checking candidate offsets:
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
const POOL = "ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw";
const info = await rpcCall("getAccountInfo", [POOL, { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
// find JitoSOL mint:
const jito = bs58.decode("J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe");
for (let off = 0; off <= buf.length - 32; off++) {
  let ok = true;
  for (let i = 0; i < 32; i++) if (buf[off + i] !== jito[i]) { ok = false; break; }
  if (ok) console.log("JitoSOL mint @ offset", off);
}
// candidate vaults: pubkeys at 72/104 and 168/200/232/264 — test token-ness:
for (const off of [72, 104, 168, 200, 232, 264, 296]) {
  const v = bs58.encode(buf.subarray(off, off + 32));
  try {
    const bal = await rpcCall("getTokenAccountBalance", [v]);
    console.log(`@${off}: ${v.slice(0, 8)} → ${bal.value.uiAmountString} (${bal.value.decimals}dec)`);
  } catch { console.log(`@${off}: not token acct`); }
}
