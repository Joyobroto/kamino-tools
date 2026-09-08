// Orca pool is 653B and owned by whirlpool program ✓ — but memcmp@101 for JitoSOL = 0 matches?!
// Calibration earlier: mintA@101 = WSOL for SOL/USDC pool. Maybe mintA≠JitoSOL here (it's mintB@181),
// AND offset 101 vs 181 assignment... Try 181 + full-scan of the pool's bytes:
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const info = await call("getAccountInfo", ["Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp", { encoding: "base64" }]);
const buf = Buffer.from(info.value.data[0], "base64");
console.log("field@101:", bs58.encode(buf.subarray(101, 133)).slice(0, 10));
console.log("field@181:", bs58.encode(buf.subarray(181, 213)).slice(0, 10));
console.log("field@133:", bs58.encode(buf.subarray(133, 165)).slice(0, 10));
console.log("field@213:", bs58.encode(buf.subarray(213, 245)).slice(0, 10));
console.log("JitoSOL mint:", "J1toso1uCk3RL".slice(0, 10));
// memcmp on offset 181:
const rows = await call("getProgramAccountsV2", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 181, bytes: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" } }], limit: 10000 }]);
console.log("whirlpool memcmp@181 JitoSOL:", (rows.accounts ?? []).length);
