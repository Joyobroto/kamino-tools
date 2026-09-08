// Calibrate program IDs via these known pools
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const POOLS = {
  "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE": "Orca SOL/USDC",
  "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2": "Raydium SOL/USDC (v4?)",
  "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv": "Raydium CLMM SOL/USDC",
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6": "Meteora SOL/USDC",
  "Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp": "Orca JitoSOL/SOL",
  "ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw": "Meteora JitoSOL/SOL",
};
for (const [k, label] of Object.entries(POOLS)) {
  const info = await rpcCall("getAccountInfo", [k, { encoding: "base64" }]);
  if (!info.value) { console.log(label, "→ gone"); continue; }
  console.log(`${label.padEnd(28)} owner=${info.value.owner} space=${Buffer.from(info.value.data[0], "base64").length}`);
}
