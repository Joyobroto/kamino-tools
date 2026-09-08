import { config as loadEnv } from "dotenv";
loadEnv();
import { address } from "@solana/kit";
import { rpcClient } from "../src/kamino.js";

const rpc = rpcClient(process.env.SOLANA_RPC_URL!);
const WALLETS = ["AcRF3Zu5imsshcy1pJ3hXt2MrMvUfdsF6eT3DXFU6re1"];
const ALTS = ["E4Yw3vdqERVNVfhfUNCHFEr3ra3pxVMtusanCU4XDP7Q", "ja2GCDWDMiNNFL79kS6Ev4wZznhgDDLxNsXwnXqKwYc", "HFotMa1QkX7fWvb7t9BhYujFZZzUf7tkJ1B73ZmGqUAz"];

for (const alt of ALTS) {
  const raw = await fetch(process.env.SOLANA_RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [alt, { encoding: "jsonParsed" }] }),
  }).then((r) => r.json());
  const info = raw?.result?.value;
  if (!info) {
    console.log(`${alt}: NOT FOUND`);
    continue;
  }
  const parsed = info?.data?.parsed;
  console.log(`${alt}: owner=${info.owner} authority=${parsed?.info?.authority} ${parsed?.info?.addresses?.length ?? 0} keys, deactivation=${parsed?.info?.deactivationSlot}`);
}

// list recent txs to see what landed
const sigs = await fetch(process.env.SOLANA_RPC_URL!, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [WALLETS[0], { limit: 10 }] }),
}).then((r) => r.json());
for (const s of sigs?.result ?? []) {
  console.log(`${s.err ? "✗" : "✓"} ${s.signature.slice(0, 20)}… slot=${s.slot}`);
}
process.exit(0);