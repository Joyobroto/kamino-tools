
export interface TelegramAlertConfig {
  /** i.e. 7123456789 */
  chatId: string;
  /** long token from @BotFather */
  botToken: string;
  /** chatids that must NOT receive alerts (e.g. the chat used for testing) */
  disabledChatIds?: string[];
}

/**
 * Reads Telegram config from env.
 * Alerts are DISABLED (returns null) unless both values are present.
 */
export function telegramConfigFromEnv(env: NodeJS.ProcessEnv): TelegramAlertConfig | null {
  const chatId = (env.TELEGRAM_CHAT_ID ?? "").trim();
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!chatId || !botToken) return null;
  return { chatId, botToken };
}

/** Strips markdown-significant characters that could break HTML parse mode. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type TelegramAlertKind =
  | "startup"
  | "test"
  | "due"
  | "promoted"
  | "taken-liquidated"
  | "taken-gone"
  | "healed"
  | "surge-on"
  | "surge-off"
  | "adl"
  | "summary"
  | "execution"
  | "swap"
  | "profit"
  | "watching"
  | "near-miss"
  | "treasure"
  | "blocked"
  | "digest";

export interface TelegramAlert {
  kind: TelegramAlertKind;
  title: string;
  lines: string[];
  body?: string;
}

/**
 * Build an HTML-formatted alert message.
 */
export function formatTelegramAlert(alert: TelegramAlert): string {
  const title = escapeHtml(alert.title);
  const lines = alert.lines.map((line) => escapeHtml(line)).map((line) => `  • ${line}`);
  return [`${title}`, ...(alert.body ? [escapeHtml(alert.body)] : []), "", ...lines].join("\n");
}

export const ALERT_RATE_LIMIT_MS = 1_500;

export interface AlertStats {
  sent: number;
  queued: number;
  dropped: number;
}

/**
 * Telegram alert sender with anti-spam protections:
 * - per-kind rate limiting (default 1 message per kind per 1.5s)
 * - message coalescing: same kind+title within 5s merges
 * - background send loop with retry
 */
export class TelegramAlerter {
  private readonly config: TelegramAlertConfig | null;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: Array<{ alert: TelegramAlert; at: number }> = [];
  private readonly lastSentAt = new Map<string, number>();
  private readonly coalesceKeys = new Map<string, { message: string; timer: NodeJS.Timeout }>();
  private running = false;
  private stats: AlertStats = { sent: 0, queued: 0, dropped: 0 };

  constructor(config: TelegramAlertConfig | null, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  get pending(): number {
    return this.queue.length;
  }

  getStats(): AlertStats {
    return { ...this.stats };
  }

  /** Sends immediately (bypasses queue). Returns success. */
  private async sendNow(message: string): Promise<boolean> {
    if (!this.config) return false;
    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (res.ok) {
        this.stats.sent += 1;
        return true;
      }
      const body = await res.text().catch(() => "");
      console.warn(`telegram alert failed: ${res.status} ${body.slice(0, 120)}`);
      this.stats.dropped += 1;
      return false;
    } catch (error) {
      console.warn(`telegram alert error: ${error instanceof Error ? error.message : String(error)}`);
      this.stats.dropped += 1;
      return false;
    }
  }

  /**
   * Queues an alert. Applies per-kind rate limiting and coalescing.
   */
  push(alert: TelegramAlert): void {
    if (!this.config) return;
    const key = `${alert.kind}:${alert.title}`;
    const now = Date.now();
    const last = this.lastSentAt.get(key) ?? 0;
    if (now - last < ALERT_RATE_LIMIT_MS && last !== 0) {
      this.stats.dropped += 1;
      return;
    }
    this.lastSentAt.set(key, now);
    this.stats.queued += 1;

    // coalesce identical kind+title within the window into one message
    const pending = this.coalesceKeys.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.coalesceKeys.delete(key);
    }
    const message = formatTelegramAlert(alert);
    const timer = setTimeout(() => {
      this.coalesceKeys.delete(key);
      this.queue.push({ alert: { ...alert }, at: Date.now() });
      if (!this.running) void this.runLoop();
    }, 10);
    this.coalesceKeys.set(key, { message, timer });
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const message = formatTelegramAlert(item.alert);
      const ok = await this.sendNow(message);
      if (!ok && this.stats.dropped < 200) {
        // retry once after short delay
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await this.sendNow(message);
      }
      // Telegram allows ~1 msg/sec; keep a safe floor
      await new Promise((resolve) => setTimeout(resolve, ALERT_RATE_LIMIT_MS));
    }
    this.running = false;
  }

  /** Used by tests: wait for queue drain and any in-flight send/retry loop. */
  async flush(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.coalesceKeys.size > 0 || this.running) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * Message builders: map tracker/screener events to Telegram alerts.
 */
export function trackerEventToAlert(event: TrackerLikeEvent): TelegramAlert | null {
  if (event.type === "spotted") {
    return {
      kind: "due",
      title: "⚡ DUE FOR LIQUIDATION",
      lines: candidateLines(event.candidate),
    };
  }
  if (event.type === "promoted") {
    return {
      kind: "promoted",
      title: "⚡ PROMOTED → DUE",
      lines: [
        ...candidateLines(event.candidate),
        `Health crossed below 1.0 (was ${event.fromHealth.toFixed(4)})`,
    ],
  };
}

  if (event.type === "watching") {
    // Suppressed from Telegram: hot-track spam (new near-miss entries every scan).
    // Visible in console only. The near-miss digest (see nearMissDigestAlert) is
    // the Telegram signal for this tier.
    return null;
  }
  if (event.type === "taken") {
    // Telegram follows the console: only surface real LIQUIDATIONS (candidates that
    // went DUE and were taken by another liquidator). Healed/managed band exits stay
    // in the JSONL only — no alert, no console line.
    if (!event.wasDue) return null;
    const lines = [
      `Obligation: ${event.obligation}`,
      `We tracked it DUE for ${event.satSeconds}s, then another bot took it.`,
    ];
    if (event.lastHealth !== undefined) {
      lines.push(`Last health seen: ${event.lastHealth.toFixed(4)}`);
    }
    if (event.debtUsd !== undefined && event.debtSymbol) {
      lines.push(`Debt: ${event.debtUsd.toFixed(2)} ${event.debtSymbol}`);
    }
    lines.push(`Missed execution window.`);
    return {
      kind: "taken-liquidated",
      title: "⚡ LIQUIDATED BY OTHERS",
      lines,
    };
  }
  if (event.type === "healed") {
    // Suppressed from Telegram: noise. Console only.
    return null;
  }
  return null;
}

/**
 * Top-N near-miss digest — the one Telegram signal for the watch tier.
 * Throttled by the caller (default 15 min); only the closest-to-DUE positions.
 */
export function nearMissDigestAlert(
  top: Array<CandidateLike & { rank: number }>,
  intervalMin: number,
): TelegramAlert {
  return {
    kind: "near-miss",
    title: `🎯 TOP ${top.length} NEAR-MISS (${intervalMin} min digest)`,
    lines: top.map((entry) => {
      const tag = entry.rank === 1 ? "🔴" : entry.rank === 2 ? "🟠" : "🟡";
      const profit = (entry.estimatedProfitUsd ?? 0).toFixed(2);
      const health = entry.healthFactor.toFixed(4);
      return `${tag} #${entry.rank} ${entry.obligation.slice(0, 8)}… hf=${health} debt:$${entry.largestDebt.amountUsd.toFixed(0)} ${entry.largestDebt.symbol} est-profit:$${profit}`;
    }),
  };
}

function candidateLines(candidate: CandidateLike): string[] {
  return [
    `Obligation: ${candidate.obligation}`,
    `Health: ${candidate.healthFactor.toFixed(4)}`,
    `Debt: ${candidate.largestDebt.amountUsd.toFixed(2)} ${candidate.largestDebt.symbol}`,
    `Est. profit: ${(candidate.estimatedProfitUsd ?? 0).toFixed(2)} USD`,
  ];
}

export interface CandidateLike {
  obligation: string;
  healthFactor: number;
  largestDebt: { amountUsd: number; symbol: string };
  estimatedProfitUsd?: number;
}

export type TrackerLikeEvent =
  | { type: "spotted"; candidate: CandidateLike }
  | { type: "promoted"; candidate: CandidateLike; fromHealth: number }
  | { type: "watching"; candidate: CandidateLike }
  | { type: "taken"; obligation: string; satSeconds: number; wasDue: boolean; dueSince: string | undefined; lastHealth?: number; debtUsd?: number; debtSymbol?: string }
  | { type: "healed"; obligation: string; lastHealth: number };

export function surgeAlert(on: boolean, dueCount: number, band: number): TelegramAlert {
  return on
    ? {
        kind: "surge-on",
        title: "⚑ SURGE MODE ON",
        lines: [`DUE positions: ${dueCount}`, `Watch band widened to ${band.toFixed(2)}`],
      }
    : {
        kind: "surge-off",
        title: "⚑ SURGE MODE OFF",
        lines: ["Market calmed, watch band back to normal"],
      };
}

export function startupAlert(cyclesPerHour: number, hotIntervalSec: number): TelegramAlert {
  return {
    kind: "startup",
    title: "🟢 Kamino Watcher Started",
    lines: [`Full scans: every ${Math.round(3600 / cyclesPerHour)}s`, `Hot ticks: every ${hotIntervalSec}s`, "Read-only — no transactions will be sent"],
  };
}

export function testAlert(): TelegramAlert {
  return {
    kind: "test",
    title: "🔔 Kamino Alert Test",
    lines: ["If you can read this, alerts are wired up correctly."],
  };
}

export function adlAlert(candidate: { obligation: string; currentLtvPct: number; adlTargetLtvPct: number; marginCallAgeHours: number }): TelegramAlert {
  return {
    kind: "adl",
    title: "◆ AUTO-DELEVERAGE MARKED",
    lines: [
      `Obligation: ${candidate.obligation}`,
      `LTV: ${candidate.currentLtvPct.toFixed(1)}% → target ${candidate.adlTargetLtvPct}%`,
      `Margin-call age: ${candidate.marginCallAgeHours}h`,
    ],
  };
}

// ---- Phase 2+ vocabulary (ready for the evaluator/executor) ----

export function executionAlert(params: { obligation: string; debt: string; attempt: number }): TelegramAlert {
  return {
    kind: "execution",
    title: "▶ EXECUTION ATTEMPT",
    lines: [`Obligation: ${params.obligation}`, `Debt: ${params.debt}`, `Attempt #${params.attempt}`],
  };
}


export function profitAlert(params: { signature: string; grossUsd: number; feesUsd: number; netUsd: number }): TelegramAlert {
  return {
    kind: "profit",
    title: "💰 PROFIT CAPTURED",
    lines: [
      `Net: $${params.netUsd.toFixed(2)} (gross $${params.grossUsd.toFixed(2)} − fees $${params.feesUsd.toFixed(2)})`,
      `Tx: ${params.signature}`,
      `Solscan: https://solscan.io/tx/${params.signature}`,
    ],
  };
}

/** Broadcast attempt failed on-chain — the "gas burned" signal (follows executor.send catch). */
export function liquidationFailedAlert(params: {
  obligation: string;
  stage: string;
  reason: string;
  gasBurnedUsd?: number;
}): TelegramAlert {
  const lines = [
    `Obligation: ${params.obligation}`,
    `Stage: ${params.stage}`,
    `Reason: ${params.reason.slice(0, 300)}`,
  ];
  if (params.gasBurnedUsd !== undefined && params.gasBurnedUsd > 0) {
    lines.push(`Gas burned: ~$${params.gasBurnedUsd.toFixed(4)}`);
  } else {
    lines.push("No SOL spent (caught pre-send)");
  }
  return { kind: "execution", title: "❌ LIQUIDATION FAILED", lines };
}

/** Daily loss cap tripped — bot paused until UTC midnight (mirrors the safe-start pattern). */
export function budgetPausedAlert(params: { dailyLossUsd: number; capUsd: number }): TelegramAlert {
  return {
    kind: "blocked",
    title: "🛑 BUDGET GUARD — PAUSED",
    lines: [
      `Daily loss: $${params.dailyLossUsd.toFixed(2)} reached the cap ($${params.capUsd.toFixed(2)}).`,
      "Liquidation firing is paused until the rolling window clears.",
      "Shadow monitoring continues — no further broadcast attempts.",
    ],
  };
}

/** Periodic heartbeat — the one place to see the whole system's health at a glance. */
export function heartbeatAlert(params: {
  uptimeMinutes: number;
  cycles: number;
  nearMissCount: number;
  dueAttempted: number;
  dueFired: number;
  liquidatedByOthers: number;
  walletSol: number;
}): TelegramAlert {
  return {
    kind: "digest",
    title: "💓 LIQ ENGINE HEARTBEAT",
    lines: [
      `Uptime: ${params.uptimeMinutes}m | Cycles: ${params.cycles}`,
      `Near-miss tracked: ${params.nearMissCount}`,
      `DUE attempts: ${params.dueAttempted} (fired: ${params.dueFired})`,
      `Lost to others (LIQUIDATED): ${params.liquidatedByOthers}`,
      `Wallet: ${params.walletSol.toFixed(4)} SOL`,
    ],
  };
}

/** Executor attempted a play and it cleared every guard — visible even in shadow mode. */
export function dueAttemptAlert(params: {
  obligation: string;
  health: number;
  repayUsd: number;
  repaySymbol: string;
  withdrawSymbol: string;
  worstProfitUsd: number;
  timingsMs: Record<string, number>;
  shadow: boolean;
  priorityLane?: string;
  tipUsd?: number;
}): TelegramAlert {
  const timing = Object.entries(params.timingsMs)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const lane = params.priorityLane && params.priorityLane !== "base-fee"
    ? ` | FASTLANE: ${params.priorityLane}${params.tipUsd ? ` ($${params.tipUsd.toFixed(2)})` : ""}`
    : "";
  return {
    kind: "execution",
    title: params.shadow ? "🔍 DUE — SIMULATED (SHADOW)" : "🔥 DUE — FIRING LIVE",
    lines: [
      `Obligation: ${params.obligation}`,
      `Health: ${params.health.toFixed(4)}`,
      `Repay: $${params.repayUsd.toFixed(2)} ${params.repaySymbol} → seize ${params.withdrawSymbol}`,
      `Worst-case profit: $${params.worstProfitUsd.toFixed(2)}${lane}`,
      timing ? `Latency: ${timing}` : "",
    ].filter(Boolean),
  };
}
