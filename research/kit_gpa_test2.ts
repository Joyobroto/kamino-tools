// kit error: actualLength 33 — memcmp bytes as address() gives 33 chars? kit wants Base58EncodedBytes string.
// Match the repo pattern in src/kamino.ts (works in prod): plain string cast.
import { createSolanaRpc, address } from "@solana/kit";
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpcUrl = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const rpc = createSolanaRpc(rpcUrl);
type Filter = { dataSize?: bigint; memcmp?: { offset: bigint; bytes: string } };
const pool = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const res = await rpc.getProgramAccounts(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP"), {
  encoding: "base64",
  filters: [{ dataSize: 165n }, { memcmp: { offset: 32n, bytes: pool as never } }] as never,
}).send();
console.log("vaults found:", res.length);
