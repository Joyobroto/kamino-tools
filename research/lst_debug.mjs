// Debug: what rates are we seeing? Instrument the lst scan by hand for JitoSOL + JupSOL.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function call(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(5000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}
const WSOL = "So11111111111111111111111111111111111111112";
const LSTS = {
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ4XfsdL9qsm7tCvWe",
  JupSOL: "jupSoLaHXQiZZTSfEWMTRRgpF3fZ4NZxXvdLHvGkd87",
};
// deepest pools per venue: use whirlpool + meteora-damm via memcmp:
const VENUES = [
  ["whirlpool", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", 653, 101, 181, 133, 213],
  ["meteora-damm", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", 904, 88, 120, 152, 184],
];
for (const [sym, mint] of Object.entries(LSTS)) {
  console.log(`\n=== ${sym} ===`);
  for (const [name, prog, size, mOffA, mOffB, vOffA, vOffB] of VENUES) {
    for (const off of [mOffA, mOffB]) {
      const rows = await call("getProgramAccountsV2", [prog, { encoding: "base64", filters: [{ dataSize: size }, { memcmp: { offset: off, bytes: mint } }], limit: 10000 }]);
      const accounts = rows.accounts ?? [];
      console.log(`  ${name} @mint-${off === mOffA ? "A" : "B"}: ${accounts.length} pools`);
      for (const a of accounts.slice(0, 2)) {
        const buf = Buffer.from(a.account.data[0], "base64");
        const [vA, vB] = [bs58.encode(buf.subarray(vOffA, vOffA + 32)), bs58.encode(buf.subarray(vOffB, vOffB + 32))];
        const bals = await call("getMultipleAccounts", [[vA, vB], { encoding: "base64" }]);
        if (!bals.value[0] || !bals.value[1]) continue;
        const rawA = Buffer.from(bals.value[0].data[0], "base64").readBigUInt64LE(64);
        const rawB = Buffer.from(bals.value[1].data[0], "base64").readBigUInt64LE(64);
        const uiA = Number(rawA) / 1e9, uiB = Number(rawB) / 1e9;
        console.log(`    pool ${a.pubkey.slice(0, 8)}: ${uiA.toFixed(0)} A + ${uiB.toFixed(0)} B → rate ${uiB / uiA}`);
      }
    }
  }
}
// Jupiter executable rate:
for (const [sym, mint] of Object.entries(LSTS)) {
  const params = new URLSearchParams({ inputMint: mint, outputMint: WSOL, amount: String(2 * 10 ** 9), slippageBps: "100" });
  const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
  if (res.ok) {
    const q = await res.json();
    console.log(`${sym} Jup executable: ${Number(q.outAmount) / 1e9} SOL per 2 LST → rate ${(Number(q.outAmount) / 1e9 / 2).toFixed(6)}`);
  }
  await sleep(1500);
}
