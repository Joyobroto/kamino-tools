// REGISTRY MINT IS WRONG! "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe" = GONE (account closed).
// The REAL JitoSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" (7.88M supply, 9 dec, mint auth set — it's the real one).
// I wrote the registry from memory and typo'd. Now verify ALL registry mints + get real ones:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const CANDIDATES = {
  JitoSOL: ["J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"],
  JupSOL: ["jupSoLaHXQiZZTSfEWMTRRgpF3fZ4NZxXvdLHvGkd87"],
  mSOL: ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcvsLYf"],
  bSOL: ["bSo13r4TkiE4KumL71LsHTPpX2t7EZ4WH7urYVFIhZ8"],
  stSOL: ["stk9ApL5He5t5dMM2bzwPsFV3fz7pNKxCHQmvHybDwn"],
  INF: ["5oVNBeEEQvYi1oX1DhQ3iW9CKQkAQZ2LqeHtXftBr6uz"],
};
for (const [sym, mints] of Object.entries(CANDIDATES)) {
  for (const mint of mints) {
    try {
      const info = await call("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
      const p = info.value?.data?.parsed?.info;
      if (!p) { console.log(`${sym} ${mint.slice(0, 20)}… → GONE/CLOSED`); }
      else console.log(`${sym} ${mint.slice(0, 20)}… → dec=${p.decimals} supply=${(Number(p.supply) / 10 ** p.decimals).toExponential(3)} mintAuth=${!!p.mintAuthority}`);
    } catch (e) { console.log(sym, mint.slice(0, 16), "ERR", e.message.slice(0, 50)); }
    await sleep(1500);
  }
}
