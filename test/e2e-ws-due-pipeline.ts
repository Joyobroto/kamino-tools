/**
 * E2E: WS-DUE trigger → executor verdict chain, shadow (no broadcast).
 *
 * Replicates the watcher's executeDue path with the race-tolerance band active:
 * a REAL near-miss obligation (health 1.00–1.02 — the marginal band that lost
 * the 2026-09-09 races to LionX) is hydrated, passes the tolerance gate, and
 * runs the full executor: pair selection → CLMM/Jupiter quote → flash-loan
 * sandwich assembly → ALT-signed tx → on-chain simulation (the program's own
 * eligibility check on fresh prices) → profit guards.
 *
 * Expectation: with a genuinely-healthy position the SIMULATION stage vetoes
 * (ObligationHealthy / Custom 6016) — proving the chain arbitrates safely and
 * the tolerance band costs nothing when the position isn't truly liquidatable.
 * Exit 0 = pipeline executed end-to-end without infrastructure errors.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { address } from "@solana/kit";
import { rpcClient } from "../src/kamino.js";
import { preloadMarket, refreshTrackedObligations } from "../src/strategies/liquidation/screener.js";
import { executeLiquidationOnce } from "../src/strategies/liquidation/execute.js";
import { loadAltState } from "../src/strategies/liquidation/setup.js";
import { resolveVetoFate } from "../src/strategies/liquidation/veto-forensics.js";

loadEnv({ quiet: true });

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const MARKET = process.env.KAMINO_MARKET ?? "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const OBLIGATION = process.argv[2] ?? "FqrB7qvTuiEs54bdh3EaQXGxt29uRJDymCe1wS7JwzXU";
const HEALTH_GATE_TOLERANCE = 0.02; // same as the watcher fire path

const stamp = (label: string): string => `[${new Date().toISOString().slice(11, 23)}] ${label}`;

async function main(): Promise<void> {
  const t0 = Date.now();
  const rpc = rpcClient(RPC_URL);
  console.log(stamp(`E2E start — obligation ${OBLIGATION}`));
  console.log(stamp(`market preload (shared hot cache)…`));
  const preloaded = await preloadMarket(rpc, MARKET);
  console.log(stamp(`market loaded (${Date.now() - t0}ms cumulative)`));

  // ── Stage 1: the live-gate hydration (exactly what executeDue does) ──
  const h0 = Date.now();
  const { candidates, obligations } = await refreshTrackedObligations({ rpc, preloaded, pubkeys: [address(OBLIGATION)] });
  const candidate = candidates[0];
  console.log(stamp(`hydrate: ${Date.now() - h0}ms — candidate=${candidate ? `${candidate.healthFactor.toFixed(4)} health, $${candidate.largestDebt.amountUsd.toFixed(2)} ${candidate.largestDebt.symbol}` : "NONE"}`));
  if (!candidate) throw new Error("hydration returned no candidate — obligation closed?");

  // ── Stage 2: the race-tolerance gate (the new marginal-band behavior) ──
  if (candidate.healthFactor >= 1 + HEALTH_GATE_TOLERANCE) {
    console.log(stamp(`gate: VETO — health ${candidate.healthFactor.toFixed(4)} ≥ ${(1 + HEALTH_GATE_TOLERANCE).toFixed(2)} (would logVeto + forensics here)`));
    await reportForensics(OBLIGATION, t0);
    return;
  }
  const marginal = candidate.healthFactor >= 1;
  console.log(stamp(`gate: PASS (${marginal ? "MARGINAL band — sim arbitrates" : "genuinely DUE"}) health=${candidate.healthFactor.toFixed(4)}`));

  // ── Stage 3: the full executor verdict chain ──
  const altState = loadAltState();
  const outcome = await executeLiquidationOnce({
    rpc,
    rpcUrl: RPC_URL,
    market: preloaded.market,
    obligationAddress: address(OBLIGATION),
    slippageBps: 50,
    minProfitUsd: 0.05,
    fast: true,
    ...(marginal ? { healthGateTolerance: HEALTH_GATE_TOLERANCE } : {}),
    ...(obligations.get(OBLIGATION) ? { prehydratedObligation: obligations.get(OBLIGATION)! } : {}),
    ...(altState ? { lookupTableAddresses: [address(altState.lookupTable)] } : {}),
    priorityMode: "auto",
    prizeUsd: Math.max(0, candidate.estimatedProfitUsd ?? 0),
  });
  console.log(stamp(`executor: stage=${outcome.stage} passed=${outcome.passed}${outcome.passed ? "" : ` reason=${outcome.reason.slice(0, 200)}`}`));
  const timings = (outcome as { timings?: Record<string, number> }).timings;
  if (timings) {
    const numeric = Object.entries(timings).filter(([, v]) => typeof v === "number") as Array<[string, number]>;
    const total = numeric.reduce((a, [, v]) => a + v, 0);
    console.log(stamp(`per-stage: ${numeric.map(([k, v]) => `${k}=${v}ms`).join("  ")}  TOTAL=${total}ms`));
    if ((timings as Record<string, unknown>).swapSource) console.log(stamp(`swap backend: ${String((timings as Record<string, unknown>).swapSource)}${(timings as Record<string, unknown>).swapFallback ? ` (fallback: ${String((timings as Record<string, unknown>).swapFallback)})` : ""}`));
  }
  if (!outcome.passed) {
    await reportForensics(OBLIGATION, t0);
    return;
  }
  console.log(stamp(`plan: repay ${outcome.plan.repayUsd.toFixed(2)} ${outcome.plan.repayReserveSymbol} → ${outcome.plan.withdrawReserveSymbol}, worst-case profit $${outcome.plan.worstCaseProfitUsd.toFixed(4)}, swap=${outcome.plan.swapSource}`));
  console.log(stamp(`timings: ${Object.entries(outcome.timings).filter(([k]) => k !== "swapSource" && k !== "swapFallback").map(([k, v]) => `${k}=${v}ms`).join("  ")}`));
  console.log(stamp(`SHADOW — not broadcasting (total ${Date.now() - t0}ms)`));
}

async function reportForensics(obligation: string, t0: number): Promise<void> {
  // The veto-forensics rail — proves the resolution logging works end-to-end.
  const fate = await resolveVetoFate({ rpcUrl: RPC_URL, obligation, triggeredAtMs: t0 });
  if (fate.outcome === "lost-race") {
    console.log(stamp(`forensics: LOST RACE — winner ${fate.winner} (${((fate.raceLostAfterMs ?? 0) / 1000).toFixed(1)}s after trigger) https://solscan.io/tx/${fate.winnerSignature}`));
  } else {
    console.log(stamp(`forensics: SELF-HEALED — no liquidation on-chain for this obligation`));
  }
}

main().catch((error) => {
  console.error(stamp(`E2E INFRA FAILURE: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
