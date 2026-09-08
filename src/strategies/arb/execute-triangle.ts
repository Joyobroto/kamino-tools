/**
 * Generic multi-leg flash-loan execution — the Kamino Triangle Engine executor.
 *
 * Same verdict chain as the LST path (plan → assemble → simulate → guards),
 * generalized to N sequential swap hops between flashBorrow and flashRepay.
 *
 *   flashBorrow USDC (Kamino, 0.001% fee)
 *     → hop1..hopN (Jupiter swap instructions, min-out floors)
 *   flashRepay principal + fee
 *
 * The atomic guarantee: if any hop misses its min-out the whole tx reverts —
 * the worst case costs only the tx fee. The simulation proves the cycle before
 * broadcast; the guards require worst-case ≥ profit floor.
 */

import { address, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { loadWalletSigner, privateKeyFromEnv } from "../../config.js";
import {
  buildFlashLoan,
  createAtaInstruction,
  deriveAssociatedTokenAccount as deriveAta,
  fetchTokenAccount,
  selectReserve,
  type TokenAccountInfo,
} from "../../kamino.js";
import type { KaminoMarket } from "@kamino-finance/klend-sdk";
import { externalInstructionsToStrategy } from "../../strategy.js";
import { createSignedTransactionWithAlt, simulate } from "../../transaction.js";
import { safeJsonStringify } from "../../ui.js";
import { fetchSwapInstructions, type JupSwapPlan } from "./lst-arb.js";
import type { TrianglePlan } from "./triangle.js";

const ATA_PROGRAM = "ATokenGPvbdgxrpT2sgsWoLtT8H9y6hktjssKpsrjqer";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

export interface MultiLegInput {
  rpc: Rpc<SolanaRpcApi>;
  rpcUrl: string;
  market: KaminoMarket;
  /** Kamino reserve asset to borrow (e.g. "USDC"). */
  reserveAsset: string;
  /** Borrow amount in the reserve's base units. */
  amountBaseUnits: bigint;
  /** The assembled plan whose hops are quoted at this exact size. */
  plan: TrianglePlan;
  /** Minimum WORST-CASE profit in USD (after flash fee estimate). */
  minProfitUsd: number;
  /** SOL price for fee accounting. */
  solPriceUsd: number;
}

export type MultiLegOutcome =
  | { stage: "assemble"; passed: false; reason: string }
  | { stage: "simulate"; passed: false; reason: string; logs: string[] }
  | { stage: "guards"; passed: false; reason: string; plan: TrianglePlan; worstProfitUsd: number }
  | {
      stage: "ready";
      passed: true;
      plan: TrianglePlan;
      transaction: Awaited<ReturnType<typeof createSignedTransactionWithAlt>>;
      signer: TransactionSigner;
      quotedProfitUsd: number;
      worstProfitUsd: number;
      computeUnitsConsumed: bigint;
      instructions: number;
    };

/** Fee model: Kamino flash fee (0.001% USDC) + tx fee (5000 lamports + light priority). */
export function cycleCostsUsd(borrowBaseUnits: bigint, solPriceUsd: number): number {
  const flashFeeUsd = (Number(borrowBaseUnits) * 0.00001) / 1e6;
  const txFeeUsd = (5000 / 1e9) * solPriceUsd + 0.0002; // base fee + small priority allowance
  return flashFeeUsd + txFeeUsd;
}

export async function executeMultiLegCycle(input: MultiLegInput): Promise<MultiLegOutcome> {
  const { rpc, market, plan } = input;

  const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
  const reserve = selectReserve(market, { asset: input.reserveAsset });
  const reserveMint = reserve.getLiquidityMint().toString();

  // 1) Fetch swap instructions for every hop at the quoted sizes.
  const legs: JupSwapPlan[] = [];
  for (const hop of plan.hops) {
    const leg = await fetchSwapInstructions(hop.quote, signer.address.toString());
    if (!leg) return { stage: "assemble", passed: false, reason: `hop ${hop.fromMint.slice(0, 6)}→${hop.toMint.slice(0, 6)} instructions unavailable` };
    legs.push(leg);
  }

  // 2) Merge hop instructions: dedupe identical setup instructions, drop
  //    reserve-ATA duplicates (the sandwich creates the borrow ATA itself),
  //    keep the last compute-budget settings per type.
  const fingerprint = (instruction: { programId: string; data: string; accounts: Array<{ pubkey: string; isWritable: boolean }> }): string =>
    `${instruction.programId}|${instruction.data}|${instruction.accounts.map((a) => `${a.pubkey}:${a.isWritable}`).join(",")}`;
  const isReserveAtaSetup = (instruction: { programId: string; accounts: Array<{ pubkey: string }> }): boolean =>
    instruction.programId === ATA_PROGRAM && instruction.accounts[3]?.pubkey === reserveMint;

  const merged: JupSwapPlan["swapInstructions"] = [];
  for (const leg of legs) {
    for (const instruction of leg.swapInstructions) {
      if (isReserveAtaSetup(instruction)) continue;
      if (merged.some((existing) => fingerprint(existing) === fingerprint(instruction))) continue;
      merged.push(instruction);
    }
  }
  const budgetMerged: JupSwapPlan["computeBudgetInstructions"] = [];
  for (const leg of legs) {
    for (const instruction of leg.computeBudgetInstructions) {
      const existingIndex = budgetMerged.findIndex(
        (existing) => existing.programId === instruction.programId && existing.data.slice(0, 8) === instruction.data.slice(0, 8),
      );
      if (existingIndex >= 0) budgetMerged.splice(existingIndex, 1);
      budgetMerged.push(instruction);
    }
  }
  if (budgetMerged.length === 0) {
    // No Jupiter budget hints (direct routes): set an explicit 300K CU limit.
    budgetMerged.push({
      programId: COMPUTE_BUDGET_PROGRAM,
      accounts: [],
      data: "AuCTBAA=", // SetComputeUnitLimit(300_000): disc 2 + u32 LE
    });
  }
  const strategy = externalInstructionsToStrategy(merged, budgetMerged, signer);

  // 3) Build the sandwich.
  const tokenAccountAddress = address(
    await deriveAta({
      mint: reserve.getLiquidityMint(),
      owner: signer.address,
      tokenProgram: reserve.getLiquidityTokenProgram(),
    }),
  );
  const existingTokenAccount = await fetchTokenAccount(rpc, tokenAccountAddress);
  const tokenAccount: TokenAccountInfo = existingTokenAccount ?? {
    address: tokenAccountAddress,
    mint: reserve.getLiquidityMint(),
    owner: signer.address,
    amount: 0n,
    decimals: reserve.getMintDecimals(),
  };
  const setupInstructions = existingTokenAccount
    ? []
    : [
        await createAtaInstruction({
          payer: signer,
          mint: tokenAccount.mint,
          owner: tokenAccount.owner,
          tokenProgram: reserve.getLiquidityTokenProgram(),
          ata: tokenAccount.address,
        }),
      ];
  const build = await buildFlashLoan({
    market,
    reserve,
    signer,
    tokenAccount,
    amountBaseUnits: input.amountBaseUnits,
    strategy,
    setupInstructions,
  });
  const lookupTables = [...new Set(legs.flatMap((leg) => leg.addressLookupTableAddresses))].map((a) => address(a));
  const transaction = await createSignedTransactionWithAlt(rpc, input.rpcUrl, signer, build.instructions, lookupTables);

  // 4) Simulate — the honest verdict.
  const simulation = await simulate(rpc, transaction);
  const logs = simulation.value?.logs ?? [];
  const simErr = simulation.value?.err;
  if (simErr) {
    return { stage: "simulate", passed: false, reason: `simulation failed: ${safeJsonStringify(simErr)}`, logs: logs.slice(-10) };
  }
  let consumedUnits = 0n;
  for (const log of logs) {
    const match = log.match(/consumed (\d+) of \d+ compute units/);
    if (match) consumedUnits = BigInt(match[1] ?? 0);
  }

  // 5) Guards: worst-case profit (min-out of the final leg) must clear the floor.
  const costsUsd = cycleCostsUsd(input.amountBaseUnits, input.solPriceUsd);
  const worstProfitUsd = Number(plan.worstProfitBaseUnits) / 1e6 - costsUsd;
  if (worstProfitUsd < input.minProfitUsd) {
    return {
      stage: "guards",
      passed: false,
      reason: `worst-case $${worstProfitUsd.toFixed(4)} (after $${costsUsd.toFixed(4)} costs) < floor $${input.minProfitUsd}`,
      plan,
      worstProfitUsd,
    };
  }

  return {
    stage: "ready",
    passed: true,
    plan,
    transaction,
    signer,
    quotedProfitUsd: Number(plan.profitBaseUnits) / 1e6 - costsUsd,
    worstProfitUsd,
    computeUnitsConsumed: consumedUnits,
    instructions: build.instructions.length,
  };
}
