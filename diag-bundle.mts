import "dotenv/config";
import { rpcClient, loadMarket } from "./src/kamino.js";
import { getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import { hydrateShortlist } from "./src/strategies/liquidation/screener.js";
import { address, getBase64EncodedWireTransaction, type Instruction, type Address } from "@solana/kit";
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
const builds: Array<{ ixs: Instruction[]; bytes: number }> = [];
const hookTx = (async (_r: never, _u: string, _sg: never, instructions: Instruction[], luts: Address[]) => {
  const tx = await createSignedTransactionWithAltCached(_r, _u, signer as never, instructions, luts);
  builds.push({ ixs: instructions, bytes: Buffer.from(getBase64EncodedWireTransaction(tx), "base64").length });
  return tx;
}) as never;
const { executeLiquidationOnce } = await import("./src/strategies/liquidation/execute.js");
const outcome = await executeLiquidationOnce({
  rpc, rpcUrl, market, obligationAddress: address(obligationValue),
  slippageBps: 50, minProfitUsd: -1, bypassHealth: true, skipSimulate: true, fast: true,
  priorityMode: "off" as const, lookupTableAddresses: tables.map(address),
  sender: senderConfigFromEnv(),
  deps: { createSignedTransaction: hookTx as never, simulate: async () => ({ context: { slot: 0n }, value: { err: null, logs: [] as string[] } }) as never },
}).catch((e) => ({ stage: "err", passed: false, reason: (e as Error).message }));
console.log("outcome:", outcome.stage, outcome.passed, "reason:", (outcome as any).reason?.slice(0, 160));
console.log("sender lane:", JSON.stringify((outcome as any).sender ?? null));
console.log("\nbuilt transactions:");
for (let i = 0; i < builds.length; i++) {
  const b = builds[i]!;
  const progs = [...new Set(b.ixs.map((ix) => ix.programAddress.toString().slice(0, 8)))];
  const hasScope = b.ixs.some((ix) => ix.programAddress.toString().startsWith("HFn8"));
  console.log(`  build[${i}] ${b.bytes} bytes ${b.bytes <= 1232 ? "OK" : "OVER"} ${hasScope ? "<WARMUP/scope>" : "<main>"} progs=${progs.join(",")}`);
}
console.log("warmupTransaction present:", Boolean((outcome as any).warmupTransaction));
