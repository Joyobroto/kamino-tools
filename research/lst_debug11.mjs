// dataSlice scan found 0?! Hp53XEtt definitely has JitoSOL@181. Let me fetch the slice for
// Hp53XEtt DIRECTLY with the same params to see what comes back:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const info = await call("getAccountInfo", ["Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp", { encoding: "base64", dataSlice: { offset: 101, length: 112 } }]);
console.log("slice len:", info.value.data[0], "→", Buffer.from(info.value.data[0], "base64").length, "bytes");
console.log("space:", info.value.space);
// Maybe whirlpool pool size isn't 653 for THIS pool? space reported earlier: 653 ✓.
// So why did the V2 scan not see it? Test V2 WITHOUT dataSize filter + dataSlice:
const page = await call("getProgramAccountsV2", ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", {
  encoding: "base64", filters: [{ dataSize: 653 }], dataSlice: { offset: 101, length: 112 }, limit: 10000,
}]);
console.log("\nV2 page1 accounts:", (page.accounts ?? []).length, "sample slice len:", page.accounts?.[0] ? Buffer.from(page.accounts[0].account.data[0], "base64").length : "n/a");
console.log("paginationKey:", page.paginationKey);
