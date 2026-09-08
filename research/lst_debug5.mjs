// field@181 IS JitoSOL on this pool, but getProgramAccountsV2 memcmp@181 → 0?!
// V2 memcmp might have different semantics (or the offset needs to skip the 8-byte discriminator
// differently in V2's indexing). Test variations: memcmp WITHOUT dataSize, classic GPA, other filters:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const JITO = "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe";
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
// 1. V2 without dataSize filter:
const r1 = await call("getProgramAccountsV2", [WHIRL, { encoding: "base64", filters: [{ memcmp: { offset: 181, bytes: JITO } }], limit: 10000 }]);
console.log("V2 memcmp@181 no dataSize:", (r1.accounts ?? []).length);
await sleep(2000);
// 2. classic GPA with same filter:
try {
  const r2 = await call("getProgramAccounts", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }, { memcmp: { offset: 181, bytes: JITO } }], dataSlice: { offset: 0, length: 0 }, withContext: false }]);
  console.log("classic GPA memcmp@181 + dataSize:", r2.length);
} catch (e) { console.log("classic GPA err:", e.message.slice(0, 80)); }
await sleep(2000);
// 3. V2 dataSize-only page 1 count:
const r3 = await call("getProgramAccountsV2", [WHIRL, { encoding: "base64", filters: [{ dataSize: 653 }], dataSlice: { offset: 0, length: 0 }, limit: 10000 }]);
console.log("V2 dataSize 653 page1:", (r3.accounts ?? []).length, "paginationKey:", r3.paginationKey);
