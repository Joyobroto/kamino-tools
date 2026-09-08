// What pools does ANB (FkiJSGKD…) trade on TODAY, and are any still mispriced?
// Find pools: token accounts owned by AMM programs holding this mint is hard; use GeckoTerminal API for token pools.
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const MINT = "FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Gecko: token info + its pools
const tRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${MINT}/pools?include=base_token,quote_token,dex`, { headers: { Accept: "application/json" } });
console.log("gecko pools status:", tRes.status);
if (tRes.ok) {
  const j = await tRes.json();
  for (const p of j.data ?? []) {
    const a = p.attributes;
    console.log(`  ${a.address} | ${a.name} | dex=${p.relationships?.dex?.data?.id} | price_usd=${Number(a.base_token_price_usd).toPrecision(4)} | vol24h=$${Math.round(Number(a.volume_usd?.h24 || 0))} | liq=$${Math.round(Number(a.reserve_in_usd || 0))} | createdAt=${a.pool_created_at}`);
  }
}
await sleep(2500);
// Gecko token overview:
const oRes = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${MINT}`, { headers: { Accept: "application/json" } });
if (oRes.ok) {
  const j = await oRes.json();
  const a = j.data?.attributes ?? {};
  console.log("\ntoken:", JSON.stringify({ name: a.name, symbol: a.symbol, price_usd: a.price_usd, fdv: a.fdv_usd, total_reserve: a.total_reserve_in_usd, volume_24h: a.volume_usd?.h24 }).slice(0, 400));
}
