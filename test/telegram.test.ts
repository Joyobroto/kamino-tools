import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTelegramAlert,
  telegramConfigFromEnv,
  trackerEventToAlert,
  surgeAlert,
  startupAlert,
  testAlert,
  executionAlert,
  profitAlert,
  nearMissDigestAlert,
  TelegramAlerter,
} from "../src/alerts/telegram.js";

test("telegramConfigFromEnv is null when missing values", () => {
  assert.equal(telegramConfigFromEnv({}), null);
  assert.equal(telegramConfigFromEnv({ TELEGRAM_CHAT_ID: "123" }), null);
  assert.equal(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "abc" }), null);
});

test("telegramConfigFromEnv reads and trims both values", () => {
  const config = telegramConfigFromEnv({ TELEGRAM_CHAT_ID: " 636238298 ", TELEGRAM_BOT_TOKEN: " tok " });
  assert.deepEqual(config, { chatId: "636238298", botToken: "tok" });
});

test("formatTelegramAlert builds HTML body with escaped values", () => {
  const message = formatTelegramAlert({
    kind: "due",
    title: "⚡ DUE <FOR> LIQUIDATION",
    lines: ["Obligation: 6qzc<>…", "Health: 0.9999"],
  });
  assert.ok(message.includes("DUE &lt;FOR&gt; LIQUIDATION"));
  assert.ok(message.includes("6qzc&lt;&gt;…"));
  assert.ok(message.includes("  • Health: 0.9999"));
});

test("trackerEventToAlert maps DUE events", () => {
  const alert = trackerEventToAlert({
    type: "spotted",
    candidate: { obligation: "ABC", healthFactor: 0.99, largestDebt: { amountUsd: 500, symbol: "USDC" }, estimatedProfitUsd: 5 },
  });
  assert.ok(alert);
  assert.equal(alert!.kind, "due");
  assert.ok(alert!.lines.some((l) => l.includes("Health: 0.9900")));
});

test("trackerEventToAlert does not claim a liquidation from a watchlist exit", () => {
  const liquidated = trackerEventToAlert({ type: "taken", obligation: "ABC", satSeconds: 68, wasDue: true, dueSince: "2026-09-04T00:00:00Z", lastHealth: 0.998, debtUsd: 50859.99, debtSymbol: "USDC" });
  const managed = trackerEventToAlert({ type: "taken", obligation: "ABC", satSeconds: 120, wasDue: false, dueSince: undefined });
  assert.equal(liquidated!.kind, "taken-gone");
  assert.equal(liquidated!.title, "⚡ LEFT WATCHLIST");
  assert.ok(liquidated!.lines.some((l) => l.includes("unverified")));
  assert.ok(liquidated!.lines.some((l) => l.includes("68s")));
  assert.ok(liquidated!.lines.some((l) => l.includes("50859.99 USDC")));
  // Band exits (healed/managed) are suppressed — no alert, matching the console.
  assert.equal(managed, null);
});

test("phase 2 vocabulary builders produce structured alerts", () => {
  assert.equal(executionAlert({ obligation: "X", debt: "103.07 FDUSD", attempt: 1 }).kind, "execution");
  const profit = profitAlert({ signature: "sig123", grossUsd: 1.05, feesUsd: 0.02, netUsd: 1.03 });
  assert.equal(profit.kind, "profit");
  assert.ok(profit.lines.some((l) => l.includes("solscan.io/tx/sig123")));
});

test("alerter with null config is disabled and drops pushes silently", async () => {
  const alerter = new TelegramAlerter(null);
  assert.equal(alerter.enabled, false);
  alerter.push(testAlert());
  assert.equal(alerter.pending, 0);
});

test("alerter sends via injected fetch and reports stats", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, text: async () => "{}" } as Response;
  }) as typeof fetch;
  const alerter = new TelegramAlerter({ chatId: "123", botToken: "tok" }, fakeFetch);
  alerter.push(testAlert());
  await alerter.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.telegram.org/bottok/sendMessage");
  const body = calls[0]!.body as { chat_id: string; parse_mode: string };
  assert.equal(body.chat_id, "123");
  assert.equal(body.parse_mode, "HTML");
  const stats = alerter.getStats();
  assert.equal(stats.sent, 1);
});

test("alerter retries once on failure", async () => {
  let attempts = 0;
  const fakeFetch = (async () => {
    attempts += 1;
    if (attempts === 1) return { ok: false, status: 500, text: async () => "err" } as Response;
    return { ok: true, status: 200, text: async () => "{}" } as Response;
  }) as typeof fetch;
  const alerter = new TelegramAlerter({ chatId: "123", botToken: "tok" }, fakeFetch);
  alerter.push(testAlert());
  await alerter.flush(15_000);
  assert.equal(attempts, 2);
});

test("surge and startup alerts build", () => {
  assert.equal(surgeAlert(true, 23, 1.44).kind, "surge-on");
  assert.equal(surgeAlert(false, 0, 1.1).kind, "surge-off");
  assert.equal(startupAlert({ cyclesPerHour: 60, hotIntervalSec: 10 }).kind, "startup");
});

test("watching and healed tracker events are suppressed from Telegram", () => {
  assert.equal(trackerEventToAlert({ type: "watching", candidate: { obligation: "ABC", healthFactor: 1.01, largestDebt: { amountUsd: 200, symbol: "USDC" } } }), null);
  assert.equal(trackerEventToAlert({ type: "healed", obligation: "ABC", lastHealth: 1.05 }), null);
});

test("near-miss digest ranks by estimated profit and formats", () => {
  const digest = nearMissDigestAlert(
    [
      { obligation: "Top1xxxxxxxxxxxxxxxxxxxx", healthFactor: 1.001, largestDebt: { amountUsd: 500, symbol: "USDC" }, estimatedProfitUsd: 484, rank: 1 },
      { obligation: "Top2yyyyyyyyyyyyyyyyyyyy", healthFactor: 1.02, largestDebt: { amountUsd: 200, symbol: "SOL" }, estimatedProfitUsd: 45, rank: 2 },
      { obligation: "Top3zzzzzzzzzzzzzzzzzzzz", healthFactor: 1.09, largestDebt: { amountUsd: 90, symbol: "mSOL" }, estimatedProfitUsd: 19, rank: 3 },
    ],
    15,
  );
  assert.equal(digest.kind, "near-miss");
  assert.ok(digest.title.includes("15 min digest"));
  assert.equal(digest.lines.length, 3);
  assert.ok(digest.lines[0]!.includes("#1"));
  assert.ok(digest.lines[0]!.includes("Top1"));
  assert.ok(digest.lines[0]!.includes("484"));
  assert.ok(digest.lines[1]!.includes("#2"));
  assert.ok(digest.lines[2]!.includes("#3"));
});
