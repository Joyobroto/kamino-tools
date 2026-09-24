import "dotenv/config";
import { rpcClient, loadMarket } from "./src/kamino.js";
import { getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import { hydrateShortlist } from "./src/strategies/liquidation/screener.js";
import { address, getBase64EncodedWireTransaction, type Instruction, type Address, appendTransactionMessageInstructions, createTransactionMessage, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { getCachedWalletSigner, createSignedTransactionWithAltCached, getCachedBlockhash } from "./src/strategies/liquidation/hotcache.js";
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
let warmupIxs: Instruction[] | null = null;
const hookTx = (async (_r: never, _u: string, _sg: never, instructions: Instruction[], luts: Address[]) => {
  if (!warmupIxs && instructions.length <= 4) warmupIxs = instructions;
  return createSignedTransactionWithAltCached(_r, _u, signer as never, instructions, luts);
}) as never;
const { executeLiquidationOnce } = await import("./src/strategies/liquidation/execute.js");
await executeLiquidationOnce({
  rpc, rpcUrl, market, obligationAddress: address(obligationValue),
  slippageBps: 50, minProfitUsd: -1, bypassHealth: true, skipSimulate: true, fast: true,
  priorityMode: "off" as const, lookupTableAddresses: tables.map(address),
  sender: senderConfigFromEnv(),
  deps: { createSignedTransaction: hookTx as never, simulate: async () => ({ context: { slot: 0n }, value: { err: null, logs: [] as string[] } }) as never },
}).catch((e) => console.log("flow threw:", (e as Error).message.slice(0, 90)));
if (!warmupIxs) { console.log("no warmup captured"); process.exit(0); }
console.log("warmup instructions:", warmupIxs.length);
for (let i = 0; i < warmupIxs.length; i++) {
  const ix = warmupIxs[i]!;
  console.log(`  ix[${i}] prog=${ix.programAddress.toString().slice(0,10)} accts=${(ix.accounts ?? []).map((a) => `${a.address.toString().slice(0,8)}:${a.role}`).join(" ")} data=${ix.data ? ix.data.length : 0}`);
}
const bh = await getCachedBlockhash(rpc, rpcUrl);
console.log("fee payer:", signer.address.toString());
const msg = pipe(createTransactionMessage({ version: 0 }), (tx)=>setTransactionMessageFeePayer(signer.address, tx), (tx)=>setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: bh.lastValidBlockHeight }, tx), (tx)=>appendTransactionMessageInstructions(warmupIxs, tx));
try {
  const signed = await signTransactionMessageWithSigners(msg);
  console.log("direct sign OK:", Buffer.from(getBase64EncodedWireTransaction(signed), "base64").length, "bytes");
} catch (e) { console.log("direct sign threw:", (e as Error).message.slice(0, 120)); }
