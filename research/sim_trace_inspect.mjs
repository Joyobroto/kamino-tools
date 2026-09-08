// Instead of guessing: rebuild the exact same tx and dump the FULL instruction order +
// each instruction's accounts, so we can see where swap outputs are sent.
import { readFileSync } from "node:fs";
// Reuse the CLI path programmatically:
process.argv = ["node", "src/cli.ts", "lst-execute", "--symbol", "JitoSOL", "--size", "500", "--dry-run"];
const env = readFileSync("/home/administrator/kamino-tools/.env", "utf8");
process.env.SOLANA_RPC_URL = env.match(/^SOLANA_RPC_URL=(.+)$/m)?.[1]?.trim() ?? "";
// We need deeper than dry-run: patch to print build.instructions — write a small script that
// mimics the CLI's middle section:
const { config } = await import("dotenv");
config({ quiet: true });
const { loadMarket, selectReserve, deriveAssociatedTokenAccount, fetchTokenAccount, createAtaInstruction, buildFlashLoan, rpcClient } = await import("../src/kamino.js");
const { privateKeyFromEnv, loadWalletSigner } = await import("../src/config.js");
const { LST_REGISTRY } = await import("../src/strategies/arb/lst.js");
const { planLstArb, fetchSwapInstructions } = await import("../src/strategies/arb/lst-arb.js");
const { externalInstructionsToStrategy } = await import("../src/strategy.js");
const { address } = await import("@solana/kit");
const { fetchSolPriceUsdc } = await import("../src/strategies/arb/quotes.js");
const { kaminoLstReference } = await import("../src/strategies/arb/scanner.js");

const rpc = rpcClient(process.env.SOLANA_RPC_URL);
const market = await loadMarket(rpc, "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const reference = kaminoLstReference(market);
const lst = LST_REGISTRY.find(l => l.symbol === "JitoSOL");
const ref = reference("JitoSOL");
console.log("oracle:", ref.solPerLst);
const solPriceUsd = await fetchSolPriceUsdc();
const result = await planLstArb(lst, ref.solPerLst, solPriceUsd, { sizeUsd: 500, solPriceUsd, slippageBps: 50, onlyDirectRoutes: true });
if (!result.ok) throw new Error(result.reason);
const plan = result.plan;
console.log("borrow (base units):", plan.amountBaseUnits.toString(), "leg1 out:", plan.legOutQuote.outAmount, "leg2 out:", plan.legBackQuote.outAmount);
const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
const leg1 = await fetchSwapInstructions(plan.legOutQuote, signer.address.toString());
const leg2 = await fetchSwapInstructions(plan.legBackQuote, signer.address.toString());
console.log("\nleg1 instructions:", leg1.swapInstructions.map(i => `${i.programId.slice(0, 8)}(${i.accounts.length} accts)`));
console.log("leg2 instructions:", leg2.swapInstructions.map(i => `${i.programId.slice(0, 8)}(${i.accounts.length} accts)`));
// merge like the CLI:
const ataProgram = "ATokenGPvbdgxrpT2sgsWoLtT8H9y6hktjssKpsrjqer";
const reserve = selectReserve(market, { asset: "JitoSOL" });
const reserveMint = reserve.getLiquidityMint().toString();
console.log("\nreserve mint:", reserveMint, "tokenProgram:", reserve.getLiquidityTokenProgram().toString());
const f = (i) => `${i.programId}|${i.data}|${i.accounts.map(a => `${a.pubkey}:${a.isWritable}`).join(",")}`;
const merged = [];
for (const i of [...leg1.swapInstructions, ...leg2.swapInstructions]) {
  if (i.programId === ataProgram && i.accounts[3]?.pubkey === reserveMint) { console.log("filtered jupiter reserve-ATA setup"); continue; }
  if (merged.some(m => f(m) === f(i))) { console.log("deduped:", i.programId.slice(0, 8)); continue; }
  merged.push(i);
}
console.log("merged strategy instructions:", merged.map(i => i.programId.slice(0, 12)));
// dump swap instruction DESTINATION accounts (token destination):
for (const [n, i] of merged.entries()) {
  if (i.programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") {
    console.log(`\nswap ${n} accounts:`);
    for (const [idx, a] of i.accounts.entries()) console.log(`  [${idx}] ${a.pubkey} ${a.isWritable ? "W" : "r"}`);
  }
}
