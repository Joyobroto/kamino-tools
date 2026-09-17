# Kamino Liquidation Engine — Status & Engineering Log

> Operating as a single-container pipeline: **monitor → analyzer → risk → executor → notifier**.
> Market: Kamino main (SOL/BTC) `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` · Program: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`

## Current state (2026-09-08)

**ARMED** — live broadcast mode with full guard chain. One incumbent competitor: **LionX** (sole active liquidator in this market, also a Jito-style arb operator).

| Component | Status |
|---|---|
| Detection | 60s full scan + 10s hot loop (in-process). WS programNotifications rail (`subscribeLiquidationSlices`) built & validated (`test/ws-smoke.ts`: SUBSCRIBED, 12 filtered notifications/240s, 9/12 present in GPA snapshot) but **not yet wired into the scan daemon** — top planned item |
| Executor | Flash-borrow liquidation chain, validated end-to-end on mainnet sim (reaches the liquidate instruction with correct economics) |
| Priority fees | FASTLANE auto (prize-based ladder, capped at 2% of worst-case profit) |
| Guards | Sim-gate (must pass simulation), profit floor $0.05, budget caps (12 att/day, $1.50 loss/day), per-obligation cooldown 30s, blocklist, kill switch |
| Notifications | Telegram: DUE attempt (with per-stage latency), fire, fail, lost-to-LionX, hourly heartbeat |
| Ledger | `data/liq_autofire_ledger.jsonl` (every attempt, stage, reason, timings) + `data/opportunities.jsonl` (scan history) |

## Pipeline

```
WS delta ──┐
hot tick ──┼─→ tracker (two-tier: DUE + watch) ─→ executeDue(obligation)
full scan ─┘                                        │
                                        ┌───────────┴───────────┐
                                  evaluateFireGuards       hydrate fresh
                                  (budget/kill switch)    (3x retry on RPC errors)
                                        │
                              pair selection (program-enforced priority:
                              lowest-liquidation-threshold collateral,
                              highest-borrow-factor debt)
                                        │
                              FASTLANE bid (prize ladder)
                                        │
                              assemble 7-ix chain → simulate → guards → BROADCAST
```

## The 7-instruction chain (hard-won ordering)

```
0. ComputeBudget (CU price — FASTLANE bid)
1. RefreshPriceList (scope v13 SDK — permissionless price crank)
2. RefreshReserve (debt reserve)
3. RefreshReserve (collateral reserve)
4. RefreshObligation (remaining accounts: deposits then borrows)
5. FlashBorrowReserveLiquidity (debt asset)
6. RefreshReserve (debt reserve AGAIN)
7. LiquidateObligationAndRedeemReserveCollateralV2
8. Jupiter swap (collateral → debt)
9. FlashRepayReserveLiquidity
```

### Why the second RefreshReserve (the three-week bug)

`flash_borrow_reserve_liquidity` ends with `reserve.last_update.mark_stale()` (klend source, `lending_operations.rs`). Any later instruction that checks reserve freshness (`assert_obligation_liquidatable` → `ReserveStale` 6009) fails unless the reserve is refreshed **again after the flash borrow**. Early debugging misattributed this to a "PythLazer EMA window race" — the real fix is ordering. LionX avoids it entirely by using `BorrowObligationLiquidityV2` (real borrow from their own obligation) instead of a flash loan.

## Economics (measured from market state)

- **Close factor**: 10% of debt (from `market.state.liquidationMaxDebtCloseFactorPct` — hardcoded 50% before the docs fix would have failed every attempt)
- **Protocol liquidation fee**: 50% of the bonus (WSOL sample; per-reserve `protocolLiquidationFeePct`)
- **Bonus range**: 100–1000 bps
- Collateral estimate: repay × bonus × (1−protocolFee) × (1−20bps haircut)
- FASTLANE bids: ~$0.03 (small plays) to ~$0.75 (prize ≥ $100), never > 2% of prize

## Screening audit (fail detection)

`test/screening-audit.ts` — cross-checks every on-chain liquidation in a window against every obligation our screener ever surfaced. Verdict `MISSED` = screening failure (the operator's definition of fail). Run: `node --import tsx test/screening-audit.ts 48`.

Known blind spot (backlog): non-vanilla obligations (tags 1–6, ~8k accounts — multiply/lending/leverage) are filtered out. The klend program has **no tag validation** in the liquidation path, so they are liquidatable; LionX's only observed victim so far was vanilla. The audit tool will flag it the day LionX takes a non-vanilla position.

## Known race profile (to re-evaluate with live data)

| Stage | Our cost | Notes |
|---|---|---|
| hydrate | ~300–600ms | single obligation, 3x retry |
| quote (Jupiter) | ~200–400ms | |
| assemble+sign | ~100ms | |
| simulate | ~400–800ms | FAST mode skips the CU-pin re-sim |
| send→land | priority-dependent | FASTLANE addresses this |

LionX: custom wrapper program (single CPI, 14 static keys) — estimated <1–2s detection-to-land. Our edge cases: catching WS deltas they ignore, near-miss re-attempts, and any market where flash-borrow works but their capital-constrained borrow doesn't.

## Ops

- Arm/disarm: add/remove `--broadcast` in docker-compose
- Kill switch: `touch data/liq_autofire.stop` (in container: `/data/liq_autofire.stop`)
- Lanes: `LIQ_PRIORITY_MODE=off|fixed|auto` (env), min profit `LIQ_MIN_PROFIT`
- Wallet `AcRF3Zu5…` needs ~0.1 SOL for comfortable operation (0.059 at arming)
- Telegram delivers: DUE attempts, fires, failures, losses to LionX, hourly heartbeat

## Execution lane: Helius Sender (2026-09-17)

Docs: <https://www.helius.dev/docs/sending-transactions/sender>

The broadcast path is now routed through **Helius Sender** — an execution-only,
credit-free, tip-based submission service — while blockhash, oracle, screening,
and confirmation keep using the existing data RPC (`SOLANA_RPC_URL`). Nothing on
the detection/valuation path changes.

| Tier | When | Routing | Min tip | Priority fee |
|---|---|---|---|---|
| **SWQOS-only** | prize < `LIQ_SENDER_MAX_PRIZE_USD` | single SWQOS path (`?swqos_only=true`) | 0.000005 SOL | any CU-price |
| **Sender Max** | prize ≥ threshold | all pathways + priority tip buffer | 0.001 SOL | ≥ 5,000 lamports |

How it is wired (`src/strategies/liquidation/sender.ts` + `execute.ts`):

1. **Tier selection by prize.** `chooseSenderLane()` picks the lane from the
   worst-case profit estimate. Small plays take SWQOS; prizes at/above the
   threshold take Sender Max. The bid moves *into the tip* — the FASTLANE CU
   price is pinned to the tier minimum so we never pay two competing bids.
2. **Tip inside the atomic sandwich.** `buildSenderTipInstruction()` adds a
   `SystemProgram.transfer` to one of the 10 designated Sender tip accounts.
   Because it is part of the same transaction, it is rolled back on any failure —
   a rejected fire burns only base + priority fee.
3. **Cost gate (refuse when the prize does not cover the cost).** The lane's
   cost = tip + priority fee + base fee, converted with the market's own WSOL
   oracle price. If `worstCaseProfit − laneCost < minProfit`, the executor
   refuses at plan stage; after simulation the gate is re-checked against the
   *measured* worst-case and the fire is refused if it no longer covers.
4. **CU-pin safety.** When the re-sim pass tightens the CU limit, the CU price is
   recomputed so the Sender priority-fee floor still holds (priority fees are
   charged on the requested limit, not consumed units).
5. **Resilient submission.** `sendViaSender()` posts the signed wire tx to
   `.../fast` (`maxRetries: 0`, `skipPreflight: true`) and confirmation polls the
   data RPC. A Sender submission failure falls back to a direct RPC send — the
   signed tx is idempotent by signature, so a duplicate is a no-op.

### Sender Max bundles (Jito mode)

When a fire's prize clears the Max threshold, it is submitted with
`method: "sendBundle"` to the same Sender endpoint (`LIQ_SENDER_BUNDLE=true`,
default on). Per the Helius docs, a Sender Max bundle routes across **every**
high-speed pathway — **Jito**, Helius, Harmonic, Rakurai, etc. — and Helius adds
the Jito/pathway tips itself: you provide only the 0.001 SOL Sender tip (already
in the sandwich) and a ≥5,000-lamport priority fee per tx. Do **not** add a
separate Jito tip or `jito-region` header for Sender Max bundles (those apply to
the *basic* RPC-proxied bundles at `mainnet.helius-rpc.com/...sendBundle`).

Bundles are atomic. Fee behaviour on a miss:

- **Local simulation fails** → we never submit → **zero cost** (the sim gate
  still runs before any broadcast).
- **Submitted but the bundle fails / is not included** → it is all-or-nothing:
  the whole bundle is dropped, the tip transfer reverts with it → **tip tidak
  kepotong**. There is no separate Jito submission fee; you pay only when the
  bundle lands.
- **Bundle lands** → tip + priority fee + base fee are all paid.

The worst-case prize gate still applies: `worstCaseProfit − laneCost <
minProfit` refuses before assembly, so a fire is only attempted when the prize
covers the Sender bundle cost.

Config: `HELIUS_SENDER_ENDPOINT` (regional endpoint closest to the host),
`LIQ_SENDER_ENABLED`, `LIQ_SENDER_MAX_PRIZE_USD`, `LIQ_SENDER_MAX_TIP_FRACTION`,
`LIQ_SENDER_MAX_TIP_CAP_SOL`, `LIQ_SENDER_MIN_PROFIT_USD`; CLI:
`--sender-endpoint`, `--no-sender`, `--sender-max-prize`. The tip accounts are
also added to the persistent ALT by `liq-setup` so the extra destination stays
inside the 1232-byte packet.

## NEXT PLAN: how we lose to LionX (and the infra guide for winning)

> Source studied: *"Solana Liquidation Bot: Why Yours Loses (Infra Guide 2026)"* by Daniel Yavorovych (Dysnix/RPC Fast), https://yavorovych.medium.com/solana-liquidation-bot-why-yours-loses-infra-guide-2026-cb518c62ff85 — full text fetched & saved to `/tmp/medium-jina.txt` during cleanup.

**The thesis:** a liquidation bot holds no alpha — every competent bot sees the same oracle tick, same positions, same health factors at the same moment. The race is a *stopwatch*, and the entire competitive budget is **<65ms from oracle tick → submitted transaction**:

1. Oracle update (the starting gun) — Pyth/Switchboard tick that flips positions under 1.0 HF
2. Detection — **<20ms**, must be pure in-memory against a cached position set (any RPC call on the hot path = lost)
3. Build + simulate — **<15ms**
4. Submit — **<30ms** via Jito bundles (atomically parking the oracle update + liquidation so both land or neither does), fired in parallel across regions/relays, calibrated tip
5. Capture or revert (reverts still pay base + priority fee, and they compound exactly when opportunity spikes)

**Why our current build is structurally slow (the 4-layer stack):**

| Layer | Standard practice | Our current state |
|---|---|---|
| Streaming (L1) | Yellowstone gRPC push filters / ShredStream via Aperture — 50–200ms head start | WebSocket HELLO + 60s/10s poll. **Ours is the big gap** |
| Health engine (L2) | Positions cached in memory indexed by feed; `onOracleUpdate` = zero I/O | We re-hydrate by account on-demand over RPC (~300–600ms/obligation) |
| Execution (L3) | Pre-signed tx templates, atomic Jito bundle, staked identity (SWQoS) | Build-from-scratch per attempt; plain `sendTransaction` on public RPC |
| RPC (L4) | Dedicated bare-metal, sub-1-slot lag, co-located, multi-region | Public RPC + retries; transient drops (the key1 429s we hit) |

Reference numbers (Q1'26 RPC Fast benchmarks, dedicated vs public): ingest lag 5–12ms vs 60–150ms · detect→submit p50 50ms vs 180ms · submission p99 45ms vs 180–400ms · win rate ~85% vs ~15% · revert rate 9% vs 55% · time-to-land p95 1–2 slots vs 3–5. The code-bound middle barely differentiates; **the spread is manufactured almost entirely by the two infra-bound segments: oracle ingest and submission.**

**Operational bleed checklist the article warns about** (all apply to us): revert rate as first-class metric (we have the ledger for it — chart it next to P&L), repaid-capital + collateral inventory ready (flash borrow already solves inventory), oracle staleness (our dual-RefreshReserve ordering is the Kamino-specific form of this), and congestion-is-correlated-with-opportunity (the price move that makes a position liquidatable is the same move that congests the network).

**Concrete next moves (in order of ROI, pending live race data):**
1. Wire the WS programNotifications rail into `scan` and make detection push-based (kill the 60s poll latency on the hot path) — closes the L1 gap closest to zero-infra-cost
2. After the first handful of live losses (or checks on LionX latencies), decide whether to go Jito-bundle submission (oracle-update + liquidate atomically) — the single highest-leverage winning move per the article
3. Multi-venue expansion (Save ~8%, MarginFi ~5%) on the same detection engine only once the Kamino pipeline is competitive — our only current "venue" is the most crowded keeper field (Kamino ~5%)
4. Revert-rate dashboard from the ledger, tied to P&L

## History: what this repo was

The LST/arb/treasure scanners were built first (Phase 0) as Kamino oracle research, then decommissioned: the LST strategy waits for a depeg event; the arb/triangle scanners found only dust-scale spreads. Code removed in v1.1 cleanup (see git history) — the treasure/LST research docs remain in `docs/` for reference.
