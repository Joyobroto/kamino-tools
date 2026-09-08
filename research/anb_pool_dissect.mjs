// Dissect ANB pools on-chain: vault composition (which side holds the $6.1M), is the "rich" pool actually sellable?
import { readFileSync } from "node:fs";
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpcCall(method, params) {
  for (let a = 1; a <= 6; a++) {
    const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.ok) { const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result; }
    if (res.status === 429) { await sleep(4000); continue; }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited out");
}
async function getMultipleAccounts(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await rpcCall("getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64" }]));
  }
  return out;
}
const MINT = "FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj";
const POOLS = [
  ["ANB/USDC meteora $0.009577 liq$6.1M", "6CnzQUJqFBdPUsB1XT7TPYUoKUn8NRML23SyNwwxAQr2", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"],
  ["ANB/USDC dammv2 $0.000018 liq$240K", "Ee8hN27zmvpkX4LimkuYz5UmjyNv2Vc1XbCvyvyohmfp", "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"],
  ["ANB/SOL dammv2 $0.0000095 liq$36K", "AsMnYhR1qZpeDMsu9D5kJYPYQtn8KsFpqe6ATV64yQHJ", "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"],
  ["ANB/USDC meteora $0.0000136 liq$16K", "3t6umb3mwQW3DcD6ucthhPLZzXiKH1P2LDbV1avtvDfk", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"],
  ["ANB/USDC orca $4.36e-7 liq$123", "AWbphoPt83peeGP7BgcRF1RqhXER22KYTdq62bo8YtQX", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
];
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
for (const [label, pool, prog] of POOLS) {
  try {
    const info = await rpcCall("getAccountInfo", [pool, { encoding: "base64" }]);
    if (!info.value) { console.log(`${label} → account gone`); continue; }
    const buf = Buffer.from(info.value.data[0], "base64");
    // scan for token vaults: find 32-byte sequences that are token accounts owned by pool
    // (simpler: getTokenAccountsByOwner on pool for both token programs)
    const res = await rpcCall("getTokenAccountsByOwner", [pool, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP" }, { encoding: "jsonParsed" }]);
    const res22 = await rpcCall("getTokenAccountsByOwner", [pool, { programId: "TokenzQdBNbLqP5VEhMpASfgMQLBV4hYsXhHtHjCgwm" }, { encoding: "jsonParsed" }]);
    console.log(`\n=== ${label} ===`);
    console.log(`  program: ${prog} | dataLen: ${buf.length}`);
    for (const t of [...res.value, ...res22.value]) {
      const p = t.account.data.parsed.info;
      const isAnb = p.mint === MINT;
      const isUsdc = p.mint === USDC;
      const isWsol = p.mint === WSOL;
      console.log(`  vault ${isAnb ? "[ANB]" : isUsdc ? "[USDC]" : isWsol ? "[WSOL]" : `[${p.mint.slice(0, 6)}]`} amount: ${p.tokenAmount.amount} (${p.tokenAmount.decimals} dec) ui=${p.tokenAmount.uiAmountString}`);
    }
  } catch (e) { console.log(`${label} ERR ${e.message.slice(0, 80)}`); }
  await sleep(800);
}
