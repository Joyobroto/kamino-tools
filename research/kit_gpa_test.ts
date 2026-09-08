// Use the repo's proven path: @solana/kit RPC (this is what screener uses — it works in prod!)
import { createSolanaRpc, mainnet, address, sol } from "@solana/kit";
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpcUrl = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const rpc = createSolanaRpc(rpcUrl);
// Token accounts owned by the famous Raydium AMMv4 SOL/USDC pool
const res = await rpc.getProgramAccounts(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP"), {
  encoding: "base64",
  filters: [{ dataSize: 165n }, { memcmp: { offset: 32n, bytes: address("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2") } }],
}).send();
console.log("vaults found:", res.length);
