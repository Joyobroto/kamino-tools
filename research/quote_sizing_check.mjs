import { readFileSync } from "node:fs";
const WSOL = "So11111111111111111111111111111111111111112";
const all = readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const e = all.find(x => x.baseMint.startsWith("6TJ6JB7k"));
// what does a TINY sell return? 1 base unit:
for (const amount of [1, 100, 10000, 324853]) {
  const params = new URLSearchParams({ inputMint: e.baseMint, outputMint: WSOL, amount: String(amount), slippageBps: "10000" });
  const res = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) { console.log(amount, "→ NOROUTE"); continue; }
  const q = await res.json();
  console.log(`sell ${amount} base → ${q.outAmount} lamports (${Number(q.outAmount) / 1e9} SOL) via ${(q.routePlan ?? []).map(s => s.swapInfo?.label).join("+")}`);
  await new Promise(r => setTimeout(r, 1500));
}
// Also: what's the mint decimals? vault data said 6 for most. 6TJ6JB7k's pool held 987M base —
// with 987M tokens and $30K market cap → price ~1.5e-7 matches 9-dec tokens? Let me fetch the mint:
import bs58 from "bs58";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const res2 = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [e.baseMint, { encoding: "jsonParsed" }] }) });
const info = (await res2.json()).result.value.data.parsed.info;
console.log("mint decimals:", info.decimals, "supply:", Number(info.supply) / 10 ** info.decimals);
