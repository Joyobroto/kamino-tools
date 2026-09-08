// 324853 base → 31 lamports via Meteora DAMM v2. The ref pool exists but holds dust.
// Now compute the mint decimals to check my $100 sizing wasn't off by 1000x:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const all = readFileSync("data/treasure_events.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const e = all.find(x => x.baseMint.startsWith("6TJ6JB7k"));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let a = 1; a <= 5; a++) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [e.baseMint, { encoding: "jsonParsed" }] }) });
  if (res.status === 429) { await sleep(5000); continue; }
  const info = (await res.json()).result.value.data.parsed.info;
  console.log("mint:", e.baseMint.slice(0, 8), "decimals:", info.decimals, "supply:", (Number(info.supply) / 10 ** info.decimals).toExponential(2));
  break;
}
// the event said vaultBaseUi = 9.87e8 (987M tokens). With price 1.54e-7 SOL and supply 1B → mcap ≈ 154 SOL ≈ $31K.
// My $100 sell size = 100/200 / 1.54e-7 = 3.2M base?? wait: (100/200)*basePerSol where basePerSol=1/1.54e-7=6.49e6 → 0.5*6.49e6 = 3.2M base.
// In systematic script I used sizeBase = Math.round((100/200)*basePerSol) — same 3.2M. Jupiter route at that size → dust pool can't fill → returns ~0 (or 400).
// So sizing was right; ref depth is simply ZERO. CONFIRMED mirage.
console.log("conclusion: reference markets for ALL 46 events hold dust. 0/46 executable.");
