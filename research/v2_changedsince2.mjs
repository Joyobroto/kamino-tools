// Something's off: 100 pages for 74 accounts? The pagination loop ran 100 times because
// paginationKey stays non-null even when accounts are empty? Docs say end = no accounts returned.
// Let's inspect ONE response raw to see actual page sizes & paginationKey behavior:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function call(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const slot = await call("getSlot", []);
const page = await call("getProgramAccountsV2", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", {
  encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 },
  limit: 10000, changedSinceSlot: slot - 400,
}]);
console.log("accounts:", page.accounts?.length, "paginationKey:", page.paginationKey);
const page2 = await call("getProgramAccountsV2", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", {
  encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 },
  limit: 10000, changedSinceSlot: slot - 400, paginationKey: page.paginationKey,
}]);
console.log("page2 accounts:", page2.accounts?.length, "paginationKey:", page2.paginationKey);
const page3 = await call("getProgramAccountsV2", ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", {
  encoding: "base64", filters: [{ dataSize: 301 }], dataSlice: { offset: 0, length: 0 },
  limit: 10000, changedSinceSlot: slot - 400, paginationKey: page2.paginationKey,
}]);
console.log("page3 accounts:", page3.accounts?.length, "paginationKey:", page3.paginationKey);
