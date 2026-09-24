import "dotenv/config";
import { rpcClient, loadMarket } from "./src/kamino.js";
import { getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import { hydrateShortlist } from "./src/strategies/liquidation/screener.js";
import { address, type Instruction } from "@solana/kit";
import { getCachedWalletSigner, createSignedTransactionWithAltCached } from "./src/strategies/liquidation/hotcache.js";
import { loadAltState, altTableAddresses } from "./src/strategies/liquidation/setup.js";
import { senderConfigFromEnv } from "./src/strategies/liquidation/sender.js";
const rpcUrl = process.env.SOLANA_RPC_URL!;
const rpc = rpcClient(rpcUrl);
const market = await loadMarket(rpc, process.env.KAMINO_MARKET!);
const obligationValue = process.argv[2] ?? "4y4tmb1ijiSqSQyxnV2G2FKFhf1A4LKrtxj4TpNU4UTp";
const li = await getCurrentLedgerInstant(rpc);
const [ob] = await hydrateShortlist({ rpc, market, ledgerInstant: li, pubkeys: [address(obligationValue)], onProgress: () => {} });
if (!ob) process.exit(1);
const tables = altTableAddresses(loadAltState());
const signer = await getCachedWalletSigner(rpcUrl);
const hookTx = (async (_r: never, _u: string, _sg: never, instructions: Instruction[], luts: (typeof tables)[number][]) => {
  console.log("hook build, instructions:", instructions.length, "luts:", luts.length);
  return createSignedTransactionWithAltCached(_r, _u, signer as never, instructions, luts as never);
}) as never;
const { executeLiquidationOnce } = await import("./src/strategies/liquidation/execute.js");
try {
  const outcome = await executeLiquidationOnce({
    rpc, rpcUrl, market, obligationAddress: address(obligationValue),
    slippageBps: 50, minProfitUsd: -1, bypassHealth: true, skipSimulate: true, fast: true,
    priorityMode: "off" as const, lookupTableAddresses: tables.map(address),
    sender: senderConfigFromEnv(),
    deps: { createSignedTransaction: hookTx as never, simulate: async () => ({ context: { slot: 0n }, value: { err: null, logs: [] as string[] } }) as never },
  });
  console.log("outcome:", outcome.stage, outcome.passed);
} catch (e) {
  console.log("THREW:", (e as Error).message);
  console.log((e as Error).stack?.split("\n").slice(1,6).join("\n"));
}
