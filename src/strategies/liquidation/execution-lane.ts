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
  const lane = outcome.sender;
  if (sender.enabled && lane) {
    const wire = wireTransaction(transaction);
    const signature = getSignatureFromTransaction(transaction);
    try {
      if (lane.bundle) {
        // Atomic Sender Max bundle (routed through Jito + all pathways). The tip
        // transfer is inside the bundle, so a failed sim/execution reverts it —
        // a miss costs nothing. Confirmation still polls the data RPC.
        await sendViaSenderBundle({ endpoint: sender.endpoint, transactions: [wire] });
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
      return sendAndConfirm(dataRpcUrl, dataRpc, transaction);
    }
    await confirmSignature(dataRpc, signature, 60_000);
    return signature;
  }
  return sendAndConfirm(dataRpcUrl, dataRpc, transaction);
}
