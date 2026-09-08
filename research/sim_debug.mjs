// Deeper: which account is NotFound? Reproduce the build + sim and dump full logs.
import { readFileSync } from "node:fs";
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
const rpc = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim().replace(/"/g, "");
// Get the full error response from simulate by re-running via the CLI but with logs env:
process.env.SOLANA_RPC_URL = rpc;
process.argv = ["node", "src/cli.ts", "lst-execute", "--symbol", "JitoSOL", "--size", "500"];
// Instead: patch the CLI? Simpler: add debug output to the error path — but we can't see which account.
// Quick empirical: use the transaction from a fresh run via monkey-patched simulate… 
// EASIEST: check the AccountNotFound cause: our wallet's WSOL ATA missing + Jupiter's ATokenGP
// create-idempotent data starts 'AQ==' (1=CreateIdempotent). The sandwich ALSO creates ATA for JitoSOL.
// AccountNotFound is usually the FEE/PAYER account… wallet exists. OR the Kamino refresh/oracle accounts?
// Dump: modify error path in CLI temporarily is fastest.
console.log("needs instrumentation");
