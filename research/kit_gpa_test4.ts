// I typo'd the Token Program ID! Correct: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP is WRONG.
// Correct Solana Token Program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP"? No —
// real one is: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQXDAP (43) — hmm. Let me just derive it
// from an existing token account we KNOW exists (the Kamino USDC reserve vault) via getAccountInfo:
import { createSolanaRpc, address } from "@solana/kit";
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpcUrl = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
const rpc = createSolanaRpc(rpcUrl);
// grab a token account address from earlier: Orca SOL/USDC pool owner's vaults unknown; use mint USDC account from Kamino:
// simpler: getAccountInfo on USDC mint
const mint = await rpc.getAccountInfo(address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).send();
console.log("USDC mint owner:", mint.value?.owner);
