/**
 * LST depeg auto-fire daemon — polls the Kamino oracle vs executable market,
 * runs the full verdict chain (plan → assemble → simulate → guards) and, when a
 * play is genuinely executable, broadcasts it.
 *
 * Operational guards (the point: an automation can only ever burn BUDGETED gas,
 * never capital — every fired tx is atomic and simulation-proven first):
 *   - kill switch: `data/autofire.stop` file stops the daemon before the next pass
 *   - per-attempt cooldown: after a fired tx, wait before re-arming
 *   - daily attempt cap + daily loss cap (fee burn from failed broadcasts)
 *   - persistent ledger: `data/autofire_ledger.jsonl` (attempts, results, signatures)
 *   - Telegram alert on every fired attempt and outcome
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { safeJsonStringify } from "../../ui.js";
export interface LstEntry {
  symbol: string;
  mint: string;
  decimals: number;
}
/** Executor verdict shape (mirrors liquidation/execute.ts outcomes). */
export interface ExecutionOutcome {
  stage: "plan" | "assemble" | "simulate" | "ready";
  passed: boolean;
  reason?: string;
}

export interface FireDecision {
  allowed: boolean;
  reason?: string;
  attemptsSoFar?: number;
  burnSoFarUsd?: number;
}

export type ExecutionOutcomeForDaemon = ExecutionOutcome;

export interface AutofireOptions {
  lsts: LstEntry[];
  /** Borrow size per attempt, USD. */
  sizeUsd: number;
  /** Slippage tolerance per leg, bps. */
  slippageBps: number;
  /** Minimum worst-case profit in USD to fire. */
  minProfitUsd: number;
  /** Minimum estimated prize before spending any RPC (dust firewall). */
  minPrizeUsd?: number;
  /** Seconds between polls when no opportunity is present. */
  intervalSec: number;
  /** Seconds to wait after a fired tx before re-arming (let the market settle). */
  cooldownSec: number;
  /** Max broadcast attempts per rolling day. */
  maxAttemptsPerDay: number;
  /** Max USD of fee burn per rolling day (failed broadcast cost model). */
  maxLossPerDayUsd: number;
  /** Ledger path (JSONL). */
  ledgerPath: string;
  /** Kill-switch path. */
  stopFilePath: string;
}

export const DEFAULT_AUTOFIRE_OPTIONS: AutofireOptions = {
  lsts: [],
  sizeUsd: 500,
  slippageBps: 50,
  minProfitUsd: 0.5,
  intervalSec: 60,
  cooldownSec: 300,
  maxAttemptsPerDay: 8,
  maxLossPerDayUsd: 1.0,
  ledgerPath: "data/autofire_ledger.jsonl",
  stopFilePath: "data/autofire.stop",
};

export interface LedgerEntry {
  at: string;
  type: "fired" | "skipped" | "blocked" | "pass" | "vetoed";
  symbol?: string;
  obligation?: string;
  stage?: ExecutionOutcomeForDaemon["stage"];
  reason?: string;
  signature?: string;
  rail?: string;
  triggeredAt?: string;
  triggerSlot?: string;
  latencyMsTotal?: number;
  timingsMs?: Record<string, number>;
  simulationLogs?: string[];
  simulationPerformed?: boolean;
  quotedProfitUsd?: number;
  worstCaseProfitUsd?: number;
  lossUsdEstimate?: number;
  /** Actual network fee, only when transaction metadata is available. */
  feeLamports?: number;
  transactionStatus?: "confirmed" | "failed" | "unknown";
  /** For "vetoed": how the veto was resolved — "lost-race" (another bot
   *  liquidated it on-chain) or "self-healed" (no liquidation ever landed). */
  outcome?: "lost-race" | "self-healed" | "no-liquidation-found" | "unknown";
  /** For "vetoed"/lost-race: the winning liquidator's fee payer. */
  winner?: string;
  /** For "vetoed"/lost-race: the winning tx signature. */
  winnerSignature?: string;
  feePayer?: string;
  liquidationSlot?: number;
  raceLostAfterMs?: number;
  /** For "vetoed": ms between the trigger and the veto. */
  latencyMs?: number;
  /** For "vetoed": the live health the hydration computed at veto time. */
  liveHealth?: number;
  /** For "vetoed": the prize that was on the table, USD. */
  prizeUsd?: number;
}

export interface DaemonState {
  lastFireAt: number | null;
  attempts: Array<{ at: number; lossUsdEstimate: number }>;
}

const DAY_MS = 86_400_000;

export function loadLedger(path: string): DaemonState {
  if (!existsSync(path)) return { lastFireAt: null, attempts: [] };
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const state: DaemonState = { lastFireAt: null, attempts: [] };
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LedgerEntry & { state?: DaemonState };
      // First line may carry the persisted state snapshot.
      if (entry.state) {
        state.lastFireAt = entry.state.lastFireAt;
        state.attempts = entry.state.attempts ?? [];
        continue;
      }
      if (entry.type === "fired") {
        state.lastFireAt = Math.max(state.lastFireAt ?? 0, new Date(entry.at).getTime());
        state.attempts.push({ at: new Date(entry.at).getTime(), lossUsdEstimate: entry.lossUsdEstimate ?? 0.001 });
      }
    } catch {
      // ignore malformed lines
    }
  }
  return state;
}

/** Drops attempt history older than one rolling day. Pure. */
export function pruneAttempts(attempts: Array<{ at: number; lossUsdEstimate: number }>, now: number): Array<{ at: number; lossUsdEstimate: number }> {
  return attempts.filter((attempt) => now - attempt.at < DAY_MS);
}

/**
 * Evaluates the operational guards for firing. Pure — unit tested.
 */
export function evaluateFireGuards(options: AutofireOptions, state: DaemonState, now: number, stopFileExists: boolean): FireDecision {
  if (stopFileExists) return { allowed: false, reason: "kill switch active (data/autofire.stop present)" };
  const attempts = pruneAttempts(state.attempts, now);
  if (attempts.length >= options.maxAttemptsPerDay) {
    return { allowed: false, reason: `daily attempt cap reached (${attempts.length}/${options.maxAttemptsPerDay})` };
  }
  const burn = attempts.reduce((sum, attempt) => sum + attempt.lossUsdEstimate, 0);
  if (burn >= options.maxLossPerDayUsd) {
    return { allowed: false, reason: `daily loss cap reached ($${burn.toFixed(3)}/$${options.maxLossPerDayUsd})` };
  }
  if (state.lastFireAt !== null && (now - state.lastFireAt) / 1000 < options.cooldownSec) {
    return { allowed: false, reason: `cooldown (${Math.ceil((options.cooldownSec - (now - state.lastFireAt) / 1000))}s left)` };
  }
  return { allowed: true, attemptsSoFar: attempts.length, burnSoFarUsd: burn };
}

/** Appends a ledger entry. */
export function logLedgerEntry(path: string, entry: LedgerEntry): void {
  appendFileSync(path, `${safeJsonStringify(entry)}\n`);
}

/** Removes the kill-switch file so the daemon can run again. */
export function clearStopFile(path: string): void {
  if (existsSync(path)) writeFileSync(path, "");
}
