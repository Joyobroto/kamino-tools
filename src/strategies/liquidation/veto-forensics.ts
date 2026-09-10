/**
 * Post-veto forensics — answers, with on-chain FACTS, why a DUE obligation we
 * declined to fire is no longer liquidatable:
 *
 *   - lost-race: another bot's LiquidateObligationAndRedeemReserveCollateral
 *     (V1/V2) LANDED on-chain after our veto. We fetch the winning tx, extract
 *     the liquidator (fee payer), the signature and the elapsed time.
 *   - self-healed: no successful liquidation exists in the obligation's recent
 *     history — the borrower (or price drift) genuinely brought it back above
 *     1.0 and nothing was taken.
 *
 * Post-mortem verified live (2026-09-09 22:07–22:11 UTC window):
 *   5xRRAGUe → lost race to 2CZ86epNMy… 43s after our veto ($83k debt, 10%
 *   close factor, ~$832 prize); E5ANmg7d → lost to LionX 3s after trigger;
 *   FDR9kwzx → lost to ewcjNU4XWc… ~42s after; EMmCS2bM/CZdDf2UW → 12+
 *   competitor attempts ALL failed on-chain (ReserveStale) and the positions
 *   truly healed — no winning liquidation in history.
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";

export interface VetoResolution {
  outcome: "lost-race" | "self-healed";
  winner?: string;
  winnerSignature?: string;
  /** Winning liquidation's block time (epoch ms), when lost-race. */
  liquidatedAt?: number;
  /** ms from our trigger to the winning liquidation, when lost-race. */
  raceLostAfterMs?: number;
}

const LIQUIDATE_LOG_PREFIX = "Instruction: LiquidateObligationAndRedeem";

interface SignatureEntry {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err: unknown | null;
}

interface ParsedTransaction {
  blockTime?: number | null;
  slot: number;
  meta?: { logMessages?: string[] } | null;
  transaction?: { message?: { accountKeys?: Array<{ pubkey: string }> } } | null;
}

/**
 * Resolves the fate of one obligation we vetoed. `triggeredAtMs` is our
 * WS-DUE trigger wall clock; the race delta is measured against it.
 * Best-effort: on RPC errors returns self-healed (never blocks the loop).
 */
export async function resolveVetoFate(params: {
  rpcUrl: string;
  obligation: string;
  triggeredAtMs: number;
  limit?: number;
}): Promise<VetoResolution> {
  const { obligation, triggeredAtMs } = params;
  const limit = params.limit ?? 30;
  try {
    const response = await fetch(params.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [obligation, { limit }],
      }),
    });
    const json = (await response.json()) as { result?: SignatureEntry[] | null };
    const signatures = json.result ?? [];
    // Inspect OK transactions, newest first, for a successful liquidation.
    for (const entry of signatures) {
      if (entry.err) continue;
      const tx = await fetchParsedTransaction(params.rpcUrl, entry.signature);
      if (!tx) continue;
      const logs = tx.meta?.logMessages ?? [];
      // A successful liquidation tx: the klend program logged the liquidate
      // instruction AND followed through ("is liquidated" only prints on success).
      const isLiquidation = logs.some((line) => line.includes(LIQUIDATE_LOG_PREFIX))
        && logs.some((line) => line.includes("Obligation is liquidated"));
      if (!isLiquidation) continue;
      const payer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
      if (!payer) continue;
      return {
        outcome: "lost-race",
        winner: payer,
        winnerSignature: entry.signature,
        liquidatedAt: (tx.blockTime ?? 0) * 1000,
        raceLostAfterMs: Math.max(0, ((tx.blockTime ?? 0) * 1000) - triggeredAtMs),
      };
    }
    return { outcome: "self-healed" };
  } catch {
    return { outcome: "self-healed" };
  }
}

async function fetchParsedTransaction(rpcUrl: string, signature: string): Promise<ParsedTransaction | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      }),
    });
    const json = (await response.json()) as { result?: ParsedTransaction | null };
    return json.result ?? null;
  } catch {
    return null;
  }
}
