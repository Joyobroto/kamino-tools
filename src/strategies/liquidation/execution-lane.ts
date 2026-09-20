/**
 * Execution-lane router — the last step before a liquidation leaves the process.
 *
 * The transaction is already built (and, when Helius Sender is enabled, already
 * carries its SOL tip + CU price). Sender is submission-only: the signature is
 * confirmed on the existing DATA RPC. A Sender submission failure (endpoint
 * down, rejection) falls back to a direct RPC send — the signed tx is idempotent
 * by signature, so a duplicate is a no-op.
 *
 * Extracted from cli.ts so the fire path can be exercised end-to-end offline.
 */

import { getSignatureFromTransaction } from "@solana/kit";
import { color } from "../../ui.js";
import { sendAndConfirm } from "../../transaction.js";
import { confirmSignature, sendViaSender, sendViaSenderBundle, wireTransaction, type SenderConfig } from "./sender.js";
import type { LiquidationOutcome } from "./execute.js";

/** The `passed: true` variant of an executor outcome. */
export type ReadyLiquidation = Extract<LiquidationOutcome, { stage: "ready" }>;

export interface BroadcastResult {
  signature: string;
  via: "sender" | "rpc";
}

export async function broadcastLiquidation(input: {
  outcome: ReadyLiquidation;
  dataRpc: Parameters<typeof sendAndConfirm>[1];
  dataRpcUrl: string;
  sender: SenderConfig;
}): Promise<string> {
  const { outcome, dataRpc, dataRpcUrl, sender } = input;
  const transaction = outcome.transaction as Parameters<typeof sendAndConfirm>[2];
  const warmup = outcome.warmupTransaction as Parameters<typeof sendAndConfirm>[2] | undefined;
  const lane = outcome.sender;
  if (sender.enabled && lane) {
    const wire = wireTransaction(transaction);
    const signature = getSignatureFromTransaction(transaction);
    // A warmup (Scope refresh) and its sandwich MUST land in order and together;
    // only an atomic bundle guarantees that. When a warmup is present we submit
    // both as a two-tx bundle even on the SWQOS lane (its tip already clears the
    // Jito minimum). The tip transfer sits in the sandwich (last) tx, so a failed
    // sim/execution reverts it — a miss costs nothing. Confirmation polls the
    // data RPC on the sandwich signature.
    const useBundle = lane.bundle || Boolean(warmup);
    try {
      if (useBundle) {
        const transactions = warmup ? [wireTransaction(warmup), wire] : [wire];
        await sendViaSenderBundle({ endpoint: sender.endpoint, transactions });
      } else {
        await sendViaSender({
          endpoint: sender.endpoint,
          tier: lane.tier,
          transaction: { wireTransaction: wire },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const label = `sender-${lane.tier}${lane.bundle ? "-bundle" : ""}`;
      console.log(color.yellow(`✗ ${label} submit failed (${message}) — falling back to direct RPC send`));
      // The warmup must land before the sandwich (RefreshObligation inside it
      // depends on the refreshed Scope prices), so send it first on fallback.
      if (warmup) {
        try {
          await sendAndConfirm(dataRpcUrl, dataRpc, warmup);
        } catch {
          // Best-effort: a failed warmup just means the sandwich will re-sim
          // ReserveStale and the caller retries on the next tick.
        }
      }
      return sendAndConfirm(dataRpcUrl, dataRpc, transaction);
    }
    await confirmSignature(dataRpc, signature, 60_000);
    return signature;
  }
  return sendAndConfirm(dataRpcUrl, dataRpc, transaction);
}
