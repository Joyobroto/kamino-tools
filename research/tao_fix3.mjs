// Maybe the Orca whirlpool address isn't a token owner the way we think, and "WrongSize" is Helius-specific.
// Test on the KNOWN-good AMMv4 pool (Raydium SOL/USDC — pools definitely own vaults) + check error details:
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
async function raw(body) {
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
const owner = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP";
const j = await raw({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { programId: TOKEN }, { encoding: "base64" }] });
console.log(j.error ? `ERR: ${JSON.stringify(j.error).slice(0, 300)}` : `OK: ${j.result.value.length} accounts`);
if (!j.error) {
  for (const t of j.result.value) {
    const buf = Buffer.from(t.account.data[0], "base64");
    const mint = (await import("bs58")).default.encode(buf.subarray(0, 32));
    console.log(" ", t.pubkey, mint.slice(0, 8), buf.readBigUInt64LE(64).toString());
  }
}
