/**
 * One-shot LST depeg execution pipeline — the single source of truth shared by
 * the `lst-execute` CLI (manual) and the `lst-autofire` daemon (automated).
 *
 * Verdict chain, in order (each stage is a hard gate):
 *   1. plan      — 2-leg quote round-trip must return ≥ borrow + fee (fail-fast)
 *   2. assemble  — Jupiter swap-instructions embedded into the flash-loan sandwich
 *   3. simulate  — full mainnet simulation; FlashRepay must succeed
 *   4. guards    — worst-case profit (min-out floors) ≥ min-profit floor
 *
 * Nothing here broadcasts. The caller does that with the returned transaction
 * after checking its own operational guards (budget caps, cooldowns, kill switch).
 */

import { address, type Rpc, type SolanaRpcApi, type TransactionSigner } from "@solana/kit";
import { loadWalletSigner, privateKeyFromEnv } from "../../config.js";
import {
  buildFlashLoan,
  createAtaInstruction,
  deriveAssociatedTokenAccount,
  fetchTokenAccount,
  selectReserve,
} from "../../kamino.js";
import type { KaminoMarket } from "@kamino-finance/klend-sdk";
import { externalInstructionsToStrategy } from "../../strategy.js";
import { createSignedTransactionWithAlt, simulate } from "../../transaction.js";
import { safeJsonStringify } from "../../ui.js";
import { fetchSolPriceUsdc } from "./quotes.js";
import { kaminoLstReference } from "./scanner.js";
import type { LstEntry } from "./lst.js";
import { fetchSwapInstructions, planLstArb, type LstArbPlan } from "./lst-arb.js";

const ATA_PROGRAM = "ATokenGPvbdgxrpT2sgsWoLtT8H9y6hktjssKpsrjqer";

export interface ExecutionInput {
  rpc: Rpc<SolanaRpcApi>;
  rpcUrl: string;
  market: KaminoMarket;
  lst: LstEntry;
  sizeUsd: number;
  slippageBps: number;
  minProfitUsd: number;
}

export type ExecutionOutcome =
  | { stage: "plan"; passed: false; reason: string; quotedProfitUsd?: number }
  | { stage: "assemble"; passed: false; reason: string }
  | { stage: "simulate"; passed: false; reason: string; logs: string[] }
  | { stage: "guards"; passed: false; reason: string; plan: LstArbPlan; worstCaseProfitUsd: number }
  | {
      stage: "ready";
      passed: true;
      plan: LstArbPlan;
      /** Signed v0 transaction — the caller decides whether to broadcast. */
      transaction: Awaited<ReturnType<typeof createSignedTransactionWithAlt>>;
      signer: TransactionSigner;
      quotedProfitUsd: number;
      worstCaseProfitUsd: number;
      computeUnitsConsumed: bigint;
      instructions: number;
      oracleSolPerLst: number;
    };

/**
 * Runs the full verdict chain for one LST. Returns a typed outcome; never throws
 * for market-condition failures (only for infrastructure errors).
 */
export async function executeLstArbOnce(input: ExecutionInput): Promise<ExecutionOutcome> {
  const { rpc, market, lst } = input;

  const reference = kaminoLstReference(market as never);
  const ref = reference?.(lst.symbol) ?? null;
  if (!ref?.solPerLst) return { stage: "plan", passed: false, reason: `${lst.symbol} has no valid Kamino oracle rate` };

  const solPriceUsd = await fetchSolPriceUsdc().catch(() => 0);
  if (solPriceUsd <= 0) return { stage: "plan", passed: false, reason: "could not derive SOL price" };

  const result = await planLstArb(lst, ref.solPerLst, solPriceUsd, {
    sizeUsd: input.sizeUsd,
    solPriceUsd,
    slippageBps: input.slippageBps,
    onlyDirectRoutes: true,
  });
  if (!result.ok) return { stage: "plan", passed: false, reason: result.reason };
  const { plan, profitUsd, worstCaseProfitUsd } = result;

  // Assemble.
  const signer = await loadWalletSigner({ privateKey: privateKeyFromEnv(), keypairPath: undefined });
  const leg1 = await fetchSwapInstructions(plan.legOutQuote, signer.address.toString());
  const leg2 = await fetchSwapInstructions(plan.legBackQuote, signer.address.toString());
  if (!leg1 || !leg2) return { stage: "assemble", passed: false, reason: "Jupiter swap-instructions unavailable" };

  const reserve = selectReserve(market, { asset: lst.symbol });
  const reserveMint = reserve.getLiquidityMint().toString();
  const isReserveAtaSetup = (instruction: { programId: string; accounts: Array<{ pubkey: string }> }): boolean =>
    instruction.programId === ATA_PROGRAM && instruction.accounts[3]?.pubkey === reserveMint;

  const fingerprint = (instruction: { programId: string; data: string; accounts: Array<{ pubkey: string; isWritable: boolean }> }): string =>
    `${instruction.programId}|${instruction.data}|${instruction.accounts.map((a) => `${a.pubkey}:${a.isWritable}`).join(",")}`;
  const merged: typeof leg1.swapInstructions = [];
  for (const instruction of [...leg1.swapInstructions, ...leg2.swapInstructions]) {
    if (isReserveAtaSetup(instruction)) continue; // the sandwich creates this ATA
    if (merged.some((existing) => fingerprint(existing) === fingerprint(instruction))) continue;
    merged.push(instruction);
  }
  const budgetMerged: typeof leg1.computeBudgetInstructions = [];
  for (const instruction of [...leg1.computeBudgetInstructions, ...leg2.computeBudgetInstructions]) {
    const existingIndex = budgetMerged.findIndex(
      (existing) => existing.programId === instruction.programId && existing.data.slice(0, 8) === instruction.data.slice(0, 8),
    );
    if (existingIndex >= 0) budgetMerged.splice(existingIndex, 1);
    budgetMerged.push(instruction);
  }
  const strategy = externalInstructionsToStrategy(merged, budgetMerged, signer);

  // Build sandwich.
  const tokenAccountAddress = address(
    await deriveAssociatedTokenAccount({
      mint: reserve.getLiquidityMint(),
      owner: signer.address,
      tokenProgram: reserve.getLiquidityTokenProgram(),
    }),
  );
  const existingTokenAccount = await fetchTokenAccount(rpc, tokenAccountAddress);
  const tokenAccount = existingTokenAccount ?? {
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
    amountBaseUnits: plan.amountBaseUnits,
    strategy,
    setupInstructions,
  });
  const transaction = await createSignedTransactionWithAlt(
    rpc,
    input.rpcUrl,
    signer,
    build.instructions,
    [...new Set([...leg1.addressLookupTableAddresses, ...leg2.addressLookupTableAddresses])].map((a) => address(a)),
  );

  // Simulate.
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

  // Guards: worst-case (min-out) profit must clear the floor. Worst case below
  // zero means a slippage event turns the play into a guaranteed loss.
  if (worstCaseProfitUsd < input.minProfitUsd) {
    return {
      stage: "guards",
      passed: false,
      reason: `worst-case $${worstCaseProfitUsd.toFixed(4)} < floor $${input.minProfitUsd}`,
      plan,
      worstCaseProfitUsd,
    };
  }

  return {
    stage: "ready",
    passed: true,
    plan,
    transaction,
    signer,
    quotedProfitUsd: profitUsd,
    worstCaseProfitUsd,
    computeUnitsConsumed: consumedUnits,
    instructions: build.instructions.length,
    oracleSolPerLst: ref.solPerLst,
  };
}
