import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoundTrip, estimateFixedCostUsd, isActionable, rankByProfit, roundTripProfitBaseUnits, roundTripSpreadBps } from "../src/strategies/arb/spread.js";
import { scanArbPass } from "../src/strategies/arb/scanner.js";
import { MINTS, type NormalizedQuote } from "../src/strategies/arb/types.js";

function quote(inputMint: string, outputMint: string, inAmount: bigint, outAmount: bigint, impact = 0.01): NormalizedQuote {
  return {
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    priceImpactPct: impact,
    routeLabels: ["Raydium CLMM"],
    fetchedAt: "2026-09-04T12:00:00.000Z",
  };
}

test("roundTripSpreadBps computes bps from raw units", () => {
  assert.equal(roundTripSpreadBps(100n, 100n), 0);
  assert.equal(roundTripSpreadBps(10_000n, 10_050n), 50); // +0.5% = 50bps
  assert.equal(roundTripSpreadBps(10_000n, 10_080n), 80); // +0.8% = 80bps
  assert.equal(roundTripSpreadBps(10_000n, 9_900n), -100); // -1% = -100bps
});

test("roundTripSpreadBps handles zero input safely", () => {
  assert.equal(roundTripSpreadBps(0n, 100n), Number.NEGATIVE_INFINITY);
});

test("roundTripProfitBaseUnits is out minus in", () => {
  assert.equal(roundTripProfitBaseUnits(1_000n, 1_030n), 30n);
  assert.equal(roundTripProfitBaseUnits(1_000n, 990n), -10n);
});

test("buildRoundTrip validates mint round-trip consistency", () => {
  const usdc = MINTS.USDC;
  const wsol = MINTS.WSOL;
  const ok = quote(usdc, wsol, 100_000n, 500_000n);
  const back = quote(wsol, usdc, 500_000n, 100_600n);
  const result = buildRoundTrip("USDC", "WSOL", 100, ok, back, 200);
  assert.ok(result);
  assert.equal(result!.spreadBps, 60); // 100600*10000/100000 - 10000 = 60
  assert.equal(result!.profitUsdApprox, 0.0006); // 600 base units of 6-decimals USDC

  // mismatched mints → null
  const wrongBack = quote(wsol, MINTS.USDT, 500_000n, 100_600n);
  assert.equal(buildRoundTrip("USDC", "WSOL", 100, ok, wrongBack, 200), null);
});

test("isActionable gates on spread, impact and net profit floor", () => {
  const good = {
    base: "USDC" as const,
    intermediate: "WSOL" as const,
    sizeUsd: 100,
    spreadBps: 60,
    profitBaseUnits: "600",
    profitUsdApprox: 0.6,
    priceImpactMaxPct: 0.05,
    routeLabels: [],
    fetchedAt: "2026-09-04T12:00:00.000Z",
  };
  assert.equal(isActionable(good, 0.0001, 0.1), true);
  assert.equal(isActionable(good, 0.0001, 5), false, "profit floor too high");
  assert.equal(isActionable({ ...good, profitUsdApprox: 0.00002, spreadBps: 1 }, 0.0001, 0.1), false, "net below floor");
  assert.equal(isActionable({ ...good, spreadBps: -5 }, 0.0001, 0.1), false, "negative spread");
  assert.equal(isActionable({ ...good, priceImpactMaxPct: 2 }, 0.0001, 0.1), false, "impact too high");
});

test("estimateFixedCostUsd models base + priority fee", () => {
  // 5000 lamports base + 100k priority at $200/SOL
  const cost = estimateFixedCostUsd(100_000, 200);
  assert.ok(Math.abs(cost - ((105_000 / 1e9) * 200)) < 1e-12);
});

test("rankByProfit sorts by net profit descending", () => {
  const make = (profit: number) => ({
    base: "USDC" as const,
    intermediate: "WSOL" as const,
    sizeUsd: 100,
    spreadBps: profit * 100,
    profitBaseUnits: String(Math.round(profit * 1e6)),
    profitUsdApprox: profit,
    priceImpactMaxPct: 0.05,
    routeLabels: [],
    fetchedAt: "2026-09-04T12:00:00.000Z",
  });
  const ranked = rankByProfit([make(0.2), make(1.5), make(0.7)], 0.1);
  assert.deepEqual(ranked.map((r) => r.profitUsdApprox), [1.5, 0.7, 0.2]);
});

test("scanArbPass end-to-end with mocked quotes finds positive spread", async () => {
  const usdc = MINTS.USDC;
  const usdt = MINTS.USDT;
  const sol = MINTS.WSOL;
  const quoteBook = new Map<string, string>([
    // SOL price probe: 1 SOL -> 200 USDC
    [`q:${sol}:${usdc}:${1 * 10 ** 9}`, JSON.stringify({ inputMint: sol, outputMint: usdc, inAmount: String(10 ** 9), outAmount: "200000000", priceImpactPct: "0.01", routePlan: [{ swapInfo: { label: "Raydium CLMM" } }] })],
    // USDC -> USDT: 100 USDC -> 100.8 USDT (80bps up)
    [`q:${usdc}:${usdt}:${100 * 10 ** 6}`, JSON.stringify({ inputMint: usdc, outputMint: usdt, inAmount: String(100 * 10 ** 6), outAmount: String(100.8 * 10 ** 6), priceImpactPct: "0.01", routePlan: [{ swapInfo: { label: "Orca" } }] })],
    // USDT -> USDC: 100.8 USDT -> 100.9 USDC (net +0.9%)
    [`q:${usdt}:${usdc}:${Math.floor(100.8 * 10 ** 6)}`, JSON.stringify({ inputMint: usdt, outputMint: usdc, inAmount: String(Math.floor(100.8 * 10 ** 6)), outAmount: String(Math.floor(100.9 * 10 ** 6)), priceImpactPct: "0.01", routePlan: [{ swapInfo: { label: "Raydium CPMM" } }] })],
    // WSOL leg: 100 USDC -> 0.5 SOL
    [`q:${usdc}:${sol}:${100 * 10 ** 6}`, JSON.stringify({ inputMint: usdc, outputMint: sol, inAmount: String(100 * 10 ** 6), outAmount: "500000000", priceImpactPct: "0.02", routePlan: [{ swapInfo: { label: "Raydium CLMM" } }] })],
    // WSOL back: 0.5 SOL -> 99.5 USDC (negative)
    [`q:${sol}:${usdc}:${500000000}`, JSON.stringify({ inputMint: sol, outputMint: usdc, inAmount: "500000000", outAmount: "99500000", priceImpactPct: "0.02", routePlan: [{ swapInfo: { label: "Orca" } }] })],
  ]);
  const fakeFetch = (async (url: string) => {
    const params = new URL(url).searchParams;
    const inputMint = params.get("inputMint")!;
    const outputMint = params.get("outputMint")!;
    const amount = params.get("amount")!;
    const body = quoteBook.get(`q:${inputMint}:${outputMint}:${amount}`);
    if (body) return { ok: true, status: 200, json: async () => JSON.parse(body) } as Response;
    return { ok: false, status: 400, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const events: string[] = [];
  const outcome = await scanArbPass(
    {
      sizeUsd: 100,
      minSpreadBps: 5,
      slippageBps: 50,
      maxPriceImpactPct: 1,
      bases: ["USDC"],
      intermediates: ["USDT", "WSOL"],
    },
    {
      fetchImpl: fakeFetch,
      onEvent: (event) => events.push(event.type),
    },
  );

  assert.equal(outcome.pairsScanned, 2);
  assert.equal(outcome.opportunities.length, 1, "only the USDT round trip clears the 5bps floor");
  assert.equal(outcome.opportunities[0]!.intermediate, "USDT");
  assert.ok(outcome.opportunities[0]!.spreadBps > 80);
  assert.ok(events.includes("opportunity"));
  assert.ok(events.includes("scan"));
  // regression: opportunity payloads must be JSON-serializable (BigInt crash in docker, 2026-09-04)
  const serialized = JSON.stringify(outcome.opportunities[0]);
  assert.ok(serialized.includes("profitBaseUnits"));
  assert.ok(typeof outcome.opportunities[0]!.profitBaseUnits === "string");
});
