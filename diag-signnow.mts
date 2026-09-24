import "dotenv/config";
import { rpcClient, loadMarket } from "./src/kamino.js";
import { getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import { hydrateShortlist } from "./src/strategies/liquidation/screener.js";
import { address } from "@solana/kit";
import { getCachedWalletSigner, createSignedTransactionWithAltCached } from "./src/strategies/liquidation/hotcache.js";
import { loadAltState, altTableAddresses } from "./src/strategies/liquidation/setup.js";
import { senderConfigFromEnv } from "./src/strategies/liquidation/sender.js";
const rpcUrl = process.env.SOLANA_RPC_URL!;
const rpc = rpcClient(rpcUrl);
const market = await loadMarket(rpc, process.env.KAMINO_MARKET!);
const li = await getCurrentLedgerInstant(rpc);
const [ob] = await hydrateShortlist({ rpc, market, ledgerInstant: li, pubkeys: [address("4y4tmb1ijiSqSQyxnV2G2FKFhf1A4LKrtxj4TpNU4UTp")], onProgress: () => {} });
if (!ob) process.exit(1);
const tables = altTableAddresses(loadAltState());
const signer = await getCachedWalletSigner(rpcUrl);
console.log("signer:", signer.address.toString().slice(0,8));
const sCfg = await senderConfigFromEnv();
const hookTx = async (_r: never, _u: string, _sg: never, instructions: import("@solana/kit").Instruction[], luts: string[]) => {
  const s = await createSignedTransactionWithAltCached(_r, _u, signer as never, instructions, luts);
  return s;
};
const { executeLiquidationOnce } = await import("./src/strategies/liquidation/execute.js");
const outcome = await executeLiquidationOnce({
  rpc, rpcUrl, market, obligationAddress: address("4y4tmb1ijiSqSQyxnV2G2FKFhf1A4LKrtxj4TpNU4UTp"),
  slippageBps: 50, minProfitUsd: -1, bypassHealth: true, skipSimulate: true, fast: true,
  priorityMode: "off" as const, lookupTableAddresses: tables.map(address),
  sender: { ...sCfg, enabled: false },
  deps: { createSignedTransaction: hookTx as never, simulate: async () => ({ context: { slot: 0n }, value: { err: null, logs: [] as string[] } }) as never },
});
console.log("outcome:", outcome.stage, outcome.passed);
if ("builtSizes" in outcome) console.log("built:", (outcome as any).builtSizes);
