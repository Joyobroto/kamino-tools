// 0 pools?? But Gecko showed Orca JitoSOL/SOL pool Hp53XEtt… and Meteora ERgpKaq5… earlier!
// The memcmp offset must be wrong OR V2 memcmp behaves differently. Earlier calibrations:
// whirlpool mintA@101 mintB@181 (VERIFIED with WSOL+USDC). JitoSOL/SOL orca pool = Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp.
// Test directly on THAT pool + also try the Eo7WjKq 944B program (mints@8/@40) — remember
// ERgpKaq59 (JitoSOL/SOL "meteora" per Gecko) was owned by Eo7WjKq!
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
for (const [label, pool] of [["Orca JitoSOL/SOL", "Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp"], ["Meteora JitoSOL/SOL", "ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw"]]) {
  const info = await call("getAccountInfo", [pool, { encoding: "base64" }]);
  console.log(`${label}: owner=${info.value?.owner} size=${Buffer.from(info.value.data[0], "base64").length}`);
}
// memcmp test on whirlpool program with JitoSOL at offset 101:
const rows = await call("getProgramAccountsV2", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 101, bytes: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" } }], limit: 10000 }]);
console.log("whirlpool memcmp@101 JitoSOL:", (rows.accounts ?? []).length);
const rows2 = await call("getProgramAccounts", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 101, bytes: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
console.log("GPA-classic memcmp@101 JitoSOL:", rows2.length);
