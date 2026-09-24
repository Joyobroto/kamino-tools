import "dotenv/config";
import { rpcClient, loadMarket } from "./src/kamino.js";
import { getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import { hydrateShortlist } from "./src/strategies/liquidation/screener.js";
import { address, type Instruction } from "@solana/kit";
import { getCachedWalletSigner, createSignedTransactionWithAltCached, primeAltCache } from "./src/strategies/liquidation/hotcache.js";
import { loadAltState, altTableAddresses, liquidationAltKeys } from "./src/strategies/liquidation/setup.js";
import { senderConfigFromEnv } from "./src/strategies/liquidation/sender.js";

const rpcUrl = process.env.SOLANA_RPC_URL!;
const rpc = rpcClient(rpcUrl);
const market = await loadMarket(rpc, process.env.KAMINO_MARKET!);
const li = await getCurrentLedgerInstant(rpc);
const [ob] = await hydrateShortlist({ rpc, market, ledgerInstant: li, pubkeys: [address("4y4tmb1ijiSqSQyxnV2G2FKFhf1A4LKrtxj4TpNU4UTp")], onProgress: () => {} });
if (!ob) process.exit(1);
const signer = await getCachedWalletSigner(rpcUrl);
const tables = altTableAddresses(loadAltState());
const genKeys = await liquidationAltKeys({ rpcUrl, market, reserves: market.getReserves(), authority: signer.address });
console.log("generated ALT keys:", genKeys.length);
const genSet = new Set(genKeys);
primeAltCache(rpcUrl, tables[0]!, [...genSet]);
console.log("primed primary ALT with", (genKeys ?? []).length, "candidate keys; overlay on-chain tables below");
for (const t of tables) {
  const { getCachedAltAddresses } = await import("./src/strategies/liquidation/hotcache.js");
  const cur = await getCachedAltAddresses(rpcUrl, t, rpc);
  console.log("  table", t.slice(0, 8), "on-chain keys:", cur.length);
}

let mainIxs: Instruction[] | null = null;
const hookTx = async (_r: never, _u: string, _sg: never, instructions: Instruction[], luts: string[]) => {
  const { getBase64EncodedWireTransaction, appendTransactionMessageInstructions, createTransactionMessage, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } = await import("@solana/kit");
  if (instructions.length > 4 && !mainIxs) {
    mainIxs = instructions;
    const { getCachedBlockhash } = await import("./src/strategies/liquidation/hotcache.js");
    const bh = await getCachedBlockhash(rpc, rpcUrl);
    const base = (fp: (tx: never) => never) =>
      pipe(
        createTransactionMessage({ version: 0 }),
        fp,
        (tx: never) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: bh.lastValidBlockHeight }, tx),
        (tx: never) => appendTransactionMessageInstructions(instructions, tx),
      );
    const trySign = async (label: string, make: () => never) => {
      try {
        const s = await signTransactionMessageWithSigners(make());
        console.log(`  EXP ${label}: OK ${Buffer.from(getBase64EncodedWireTransaction(s), "base64").length} bytes`);
      } catch (e) {
        console.log(`  EXP ${label}: THREW ${(e as Error).message.slice(0, 110)}`);
      }
    };
    const stripped = instructions.map((ix) => ({ ...ix, accounts: (ix.accounts ?? []).map((a) => ("signer" in a ? { address: a.address, role: (a as any).role } : a)) }));
    const base3 = pipe(
      createTransactionMessage({ version: 0 }),
      (tx: never) => setTransactionMessageFeePayerSigner(signer, tx),
      (tx: never) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: bh.lastValidBlockHeight }, tx),
      (tx: never) => appendTransactionMessageInstructions(stripped as never, tx),
    );
    await trySign("(a) fp=address       ", () => base((tx: never) => setTransactionMessageFeePayer(signer.address, tx)));
    await trySign("(b) fp=signer        ", () => base((tx: never) => setTransactionMessageFeePayerSigner(signer, tx)));
    await trySign("(c) fp=signer+stripped", () => base3);
    {
      const { compressTransactionMessageUsingAddressLookupTables, getBase64EncodedWireTransaction } = await import("@solana/kit");
      const { getCachedAltAddresses } = await import("./src/strategies/liquidation/hotcache.js");
      const contents: Record<string, string[]> = {};
      for (const t of luts) contents[String(t)] = (await getCachedAltAddresses(rpcUrl, String(t), rpc)).map(String);
      console.log("  EXP table merges:", Object.entries(contents).map(([k, v]) => `${k.slice(0, 8)}=${v.length}`).join(", "));
      const mRaw = base((tx: never) => setTransactionMessageFeePayerSigner(signer, tx));
      for (const [i, coverage] of [contents, {} as Record<string, string[]>].entries()) {
        const cm = compressTransactionMessageUsingAddressLookupTables(mRaw as never, coverage as never);
        const keys = new Set((cm as any).instructions.flatMap((ix: any) => (ix.accounts ?? []).filter((a: any) => "address" in a).map((a: any) => a.address.toString())));
        const all = new Set(Object.values(contents).flat());
        const match = [...keys].filter((k) => all.has(k));
        console.log(`  EXP compress[${coverage === contents ? "A" : "B"}] inlineKeys=${keys.size} lookupMetas=${(cm as any).instructions.reduce((m: number, ix: any) => m + (ix.accounts ?? []).filter((a: any) => !("address" in a)).length, 0)} exposed=${(cm as any).instructions.reduce((m: number, ix: any) => m + (ix.accounts ?? []).length, 0)} overlapped=${match.length}`);
        try {
          const ss = await signTransactionMessageWithSigners(cm);
          console.log(`  EXP compress[${coverage === contents ? "A" : "B"}] SIGN-NO-WIRE OK; attempting wire...`);
          try { console.log(`  EXP compress[${coverage === contents ? "A" : "B"}] wire=${Buffer.from(getBase64EncodedWireTransaction(ss), "base64").length}`); }
          catch (e) { console.log(`  EXP compress[${coverage === contents ? "A" : "B"}] WIRE THREW ${(e as Error).message.slice(0, 100)}`); }
        } catch (e) {
          console.log(`  EXP compress[${coverage === contents ? "A" : "B"}] SIGN THREW ${(e as Error).message.slice(0, 100)}`);
        }
      }
    }
  }
  const s = await createSignedTransactionWithAltCached(_r, _u, signer as never, instructions, luts);
  const wire = Buffer.from(getBase64EncodedWireTransaction(s), "base64");
  const progs = instructions.map((i) => i.programAddress.toString().slice(0, 8));
  const tag = instructions.length <= 4 ? "WARMUP" : progs.includes("DF1ow4ts") ? "KSWAP" : progs.includes("JUP6LkbZ") ? "JUPITER" : "MAIN?";
  console.log(`  build[${tag}] ${wire.length} bytes n=${instructions.length} progs=${progs.join(",")}`);
  return s;
};

const sCfg = await senderConfigFromEnv();
const { executeLiquidationOnce } = await import("./src/strategies/liquidation/execute.js");
const outcome = await executeLiquidationOnce({
  rpc, rpcUrl, market, obligationAddress: address("4y4tmb1ijiSqSQyxnV2G2FKFhf1A4LKrtxj4TpNU4UTp"),
  slippageBps: 50, minProfitUsd: -1, bypassHealth: true, skipSimulate: true, fast: true,
  priorityMode: "off" as const, lookupTableAddresses: tables.map(address),
  sender: sCfg,
  deps: { createSignedTransaction: hookTx as never, simulate: async () => ({ context: { slot: 0n }, value: { err: null, logs: [] as string[] } }) as never },
});
console.log("outcome:", outcome.stage, outcome.passed, "reason:", JSON.stringify((outcome as any).reason ?? "").slice(0, 200));