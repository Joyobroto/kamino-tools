# Kamino Liquidation Bot — Build Plan

**Goal:** Net ~$10/day average via flash-loan liquidations on Kamino Lend long-tail obligations, using this repo's existing atomic borrow→strategy→repay engine.

## Context

- Repo = execution engine only (flash borrow/repay, simulate rail, safety gates). No alpha logic exists yet.
- **Strategy chosen:** liquidation long-tail — small obligations ($100–$5K debt) skipped by MEV bots. NOT DEX arb (speed race we lose with CLI + RPC latency).
- **Edge:** 0% flash fee assets (USDS/USDG/PYUSD/EURC/LSDs) + atomic revert = free retries. One tail hit ≈ full day target.
- **Setup constraints:** Helius polling RPC, vanilla obligations only, <0.5 SOL budget, dry-run first.

## Decisions locked

| Decision | Choice |
|---|---|
| Strategy | Liquidation long-tail (not DEX arb) |
| Detection | Polling via Helius `getProgramAccounts` (webhooks later) |
| Scope | Vanilla obligations only (multiply/PDA later) |
| Build order | Screener-first, read-only validation week |
| Risk | <0.5 SOL, dry-run before any broadcast |

## Phase 1 — Screener (read-only, zero risk) ← CURRENT (BUILT & VALIDATED ON MAINNET)

**Status: complete.** Full-market scan runs against Helius in ~39s/cycle.

**Mainnet calibration findings (2026-09-03):**

- Kamino Main market holds ~105,944 obligation accounts; ~57K with cached debt > 0.
- Raw GPA with `dataSlice(offset 2208, len 64)` reads cached health values for ALL obligations in ~7s (the SDK's built-in `batchGetAllObligationsForMarket` is unusable here: fixed dataSize filter mismatches, and full hydration of 106K accounts triggers Helius 429s).
- Two-phase architecture: cached-slice snapshot → hydrate only the cached-unhealthy, in-debt-band shortlist (~8.4K accounts) → refresh oracles.
- Sf values scale: ÷1e18 = USD. Byte offsets (empirically verified): debt@2208, unhealthy@2256.
- Dust pre-filter (cached debt < 50% of min band) cut hydration from 38K → 8.4K accounts; scan 5m44s → 39s.
- First scan results: 0 liquidatable at that moment (calm market), but 564 near-miss (health 1.0–1.05) with est. profits $10–$228 each — the pipeline is healthy, waiting for volatility.

**Watch loop:** `npm run cli -- scan --watch --interval 60 --log opportunities.jsonl` — logs `snapshot` / `spotted` / `taken` / `summary` JSONL events. The `taken` events measure how long tail positions actually sit (the key validation metric).

**Validation gate (3–7 days of watch logs):**

- ≥5 tail opportunities/day clearing profit floor
- Avg time-sitting >60s (no speed infra needed)
- Fail → thesis dead, zero SOL burned. Pass → Phase 2.

## Phase 2 — Evaluator

- `src/strategies/liquidation/swap.ts` — Jupiter quote → swap instruction w/ min-out
- Exact profit: `bonus − slippage − flash fee − priority fee`
- Rank candidates by net profit

## Phase 3 — Executor (simulate-only)

- `src/strategies/liquidation/execute.ts` — `refreshReserves` + `refreshObligation` + `liquidateObligation` + swap injected as strategy instructions into existing `buildFlashLoan` (src/kamino.ts:160)
- Full-tx simulate via existing rail; profit floor hard-gate

## Phase 4 — Live

- Broadcast gated: `--yes` flag + simulated profit ≥ $0.50 + Jupiter min-out enforced
- P&L logging, daily summary

## Auto-deleverage (ADL) detection — BUILT (2026-09-03)

The scanner now also detects obligations **marked for auto-deleveraging** by Kamino risk admins (`markObligationForDeleveraging`). These are positions flagged with a target LTV that fillers can deleverage for profit — a permissionless backrun-style opportunity with far fewer competitors than liquidation.

**Empirical findings (2026-09-03):**

- All 58 Main-market reserves have deleveraging params configured (7-day margin-call period, threshold decays 72 bps/day) — the mechanism is live.
- **0 of 140,370 obligations across all 71 Kamino markets are currently marked** — admins only mark during risk events (e.g., collateral depegs).
- Implication: rare but potentially lucrative. The watcher now records ADL events the moment they appear.

**Implementation:** dataSlice extended 64→130 bytes (covers `autodeleverageTargetLtvPct` @2321, `autodeleverageMarginCallStartedTimestamp` @2328). ADL-marked obligations are force-hydrated regardless of health band. Output: `◆ AUTO-DELEVERAGE MARKED` section (purple) + `adlMarked` array in JSONL snapshots, including `adlTargetLtvPct`, `currentLtvPct`, `marginCallAgeHours`.

**Opportunity ranking update:** liquidation tail remains #1 (561 near-miss ammo). ADL is #2 — zero current supply, but zero competition when it fires.

## WebSocket realtime upgrade — DEFERRED (decision gate: satSeconds data)

`ws/AccountSubscriptionManager` (same SDK) provides push-based obligation updates via program-level WSS notifications (~1 slot ≈ 400ms vs our 60s poll), with auto-reconnect/dedup handled. Architecture when needed: GPA snapshot (phase A) once → WS program-level memcmp filter streams deltas. **Do not build until validation-week data shows median satSeconds < ~15s** (i.e., speed actually matters). Otherwise polling 60s is sufficient and WS is premature optimization. Also verify Helius tier WSS connection limits before adopting. Full design: [docs/WEBSOCKET_REALTIME.md](WEBSOCKET_REALTIME.md).

## Liquidation-history cross-check (2026-09-03, calm-market baseline)

**Purpose:** verify that (a) our watcher correctly shows DUE=0 when there is nothing due, and (b) nothing is being missed.

**Method:** walked ~10,000+ KLend program signatures (≈7–8h window, 03:07→11:23 UTC), sampled 1,500+ clean transactions two ways: log-line matching (`Instruction: Liquidat*`) and raw instruction-data discriminator matching (`LiquidateObligationAndRedeemReserveCollateral` 8-byte anchor disc `b1,47,9a,bc,e2,85,4a,37`), plus Helius Enhanced Transactions API.

**Result: 0 liquidation executions in the sampled window — watcher (207 cycles, DUE=0, ADL=0) matches on-chain reality perfectly.** The market is genuinely calm right now (also implied by stable near-miss pool ~561, no SOL volatility this session). Detection format verified: discriminator bytes derived from SDK codegen and confirmed correct, so when a real liquidation fires, both our scanner (health < 1.0 → DUE) and this research method would see it.

**Note:** this session also surfaced and fixed a bug where Helius 429s surfaced as opaque `Solana error #8100002` (context.statusCode=429) and bypassed our backoff — detector hardened + unit-tested (test/screener.test.ts), market load & ledger instant now also retried with backoff.

## FIRST LIQUIDATION CAPTURED — empirical validation (2026-09-03, obligation `6qzcv4qA…LHCzbP`)

Our near-miss #1 (health 1.0002, debt $103.07 FDUSD, seen in our logs at 21:35:44 UTC) was **liquidated 68 seconds later at 21:36:52 UTC** by an external bot:

- Tx: `3LUqFmbWErsAfn318FyL9TEHWtc3euvanH87Pvww5Bx1XJwRfoiXvbJH3CMTn2dnrAWX9RskuJGFujuxwGRaEB4U`
- Liquidator (fee payer): `LionX7R69tL1EEcpRkJ9jRuwV7bi4jFoKmZZnxiVK6y` + flash-loan wallet `9DrvZvyW…`
- Execution: `RefreshObligation` → **`LiquidateObligationAndRedeemReserveCollateralV2`** (repaid $103.23 FDUSD, seized $104.27 USDS) → Jupiter `SharedAccountsRouteV2` swap — **exactly the Phase 3 architecture we planned**
- Liquidation bonus applied on-chain: **100bps (1%)** — the MIN, not the max
- Bot's net profit: ~**$0.13** (thin — this is a small tail position)
- After liquidation (close factor 10%), obligation self-healed: debt $103→$92.85, health 1.0107 — dropped out of our near-miss band, replaced by next candidates. This is the "gone from near-miss" behavior: **correct, by design.**

**Two hard lessons locked into the codebase:**

1. **Bonus estimation fixed:** screener now uses `minLiquidationBonusBps` (conservative), not `maxLiquidationBonusBps`. Our old estimate said $10.31 profit; reality was ~$0.13 — the old code over-estimated by ~80x. Main-market stables: min 100bps / max 1000bps. Est. profit now ≈ debt × 1% for stables.
2. **Speed observed:** position sat in near-miss for hours, but once DUE, was executed within **~68 seconds**. Early `satSeconds` signal suggests competitive field — reinforces the WebSocket decision gate (see WEBSOCKET_REALTIME.md).

**Watcher validation status: WORKING** — captured the candidate pre-liquidation with correct health, and the disappearance was a real liquidation, not a missed event.

## Hot watch — blind-window fix (2026-09-04, BUILT)

**The miss:** our first captured liquidation (`6qzcv4qA…`) crossed below 1.0 and was executed **entirely inside one 60s polling gap** (~68s DUE→liquidated). The full scan never saw it DUE; the position had already self-healed by the next cycle. With a ~100-150s effective full-cycle time, every fast liquidation would be invisible.

**The fix (three-layer):**

1. **`HotTracker` (src/strategies/liquidation/tracker.ts)** — pure state machine: full scans `absorb()` DUE candidates (spotted events); a fast targeted loop `applyHotUpdate()` re-hydrates ONLY tracked obligations every **10s** (`--hot-interval`), emitting `promoted` (crossed into DUE between full scans), `taken` (gone — liquidated/closed, with accurate `satSeconds`), and `healed` (borrower repaid/topped-up, released).
2. **Targeted refresh path (`refreshTrackedObligations`)** — hydrates only tracked addresses (a handful, not 8K) with fresh oracles via the SDK, so hot checks see live health, not stale cached bytes.
3. **Interleaved scheduler in the watch loop** — full scan every 60s, hot ticks every 10s in between (also capped at the full interval, min 5s).

**Cost:** near-zero — hot ticks only fetch ~1-20 accounts when something is tracked; idle when the hot list is empty.

**Event vocabulary in JSONL now:** `snapshot` | `spotted` | `promoted` | `taken` (satSeconds) | `healed` | `summary` (now includes `hotTracked`/`hotDue`).

**Expected effect:** the next `6qzcv4qA`-style event will be visible as `⚡ PROMOTED→DUE` within ≤10s of crossing, and if a bot takes it we log a true `satSeconds` instead of losing the trail. Note: near-miss-only positions (1.0–1.05, healthy) are intentionally NOT hot-tracked — only confirmed DUE positions are; that keeps hot costs trivial. The remaining blind window is: first crossing to first hot touch ≤10s, which is the floor without WebSocket (see WEBSOCKET_REALTIME.md).

## Competitor intelligence (2026-09-04) — see docs/COMPETITOR_INTEL.md

First 19.6h of live watching, calm market: **1 missed-DUE event (the known `6qzcv4qA`), 3 total
liquidations in-window, all executed by ONE bot** (`LionX…`, a general swap bot with ~14s tx
cadence, aux flash-loan wallet `9DrvZvyW…`). Every liquidation was tail-sized with ~$0.10–1.50
profit; near-miss→DUE conversion is rare (1/583 tracked positions); most risky positions
self-heal (borrowers repay/top-up) or drift safe. Implications: hot-watch (10s) is faster than
the incumbent's observed reaction; calm-market profit < $5/day → the go/no-go gate REQUIRES a
volatile day sample; consider lowering profit floor to ~$0.15 in Phase 2 to capture what LionX skips.

## Surge coverage (2026-09-04, BUILT) — surviving DUE floods

**Problem:** in a dump, the 550+ near-miss pool converts to DUE simultaneously; the old
architecture would (1) miss crossings inside the 60s polling gap, (2) choke on hydration as
the cached-health shortlist balloons 8K→30K+ accounts, (3) starve hot ticks while a full scan runs.

**Four-layer surge defense (live):**

1. **Two-tier hot tracker** (`src/strategies/liquidation/tracker.ts`) — DUE tier (always tracked,
   uncapped) + watch tier: near-miss positions with health < `--hot-band` (default 1.02) are
   hot-refreshed every 10s, so the crossing→`PROMOTED→DUE` latency is one hot tick, not one full
   scan. Under surge, the watch tier self-trims to `--max-hot-watch` (default 60) keeping the
   positions CLOSEST to the line — the tracker deliberately narrows onto the most endangered.
2. **Parallel hydration** — `hydrateShortlist` now runs 3 concurrent paced workers (batch 100,
   250ms pacing per worker); full-scan throughput ~3x with backoff retaining 429 immunity.
3. **Adaptive watch band** — when a full scan finds DUE > 0, the next scan's hydration band widens
   (up to 2x, scaled by DUE count) to pull in positions further from the line BEFORE they cross;
   clears automatically when the tracker drains (`⚑ SURGE MODE ON/OFF` in logs).
4. **Concurrent scheduler** — hot ticks fire even while a full scan is in flight; a long hydration
   pass can no longer starve the 10s hot loop (the missing-`6qzcv4qA` failure mode).

**Event vocabulary:** `watching` (entered watch tier) · `spotted` (DUE via full scan) ·
`promoted` (crossing caught by hot tick) · `taken` (gone; `wasDue` distinguishes liquidated-vs-managed) ·
`healed` (rose above band) · `summary` now carries `hotTracked`/`hotDue`/`hotWatch`/`adaptiveBand`.

**Stale-data guard:** full scans can no longer resurrect a DUE entry into the watch tier from a
stale observation (hot loop always wins) — unit-tested surge regression case.

## Telegram alerts (2026-09-04, LIVE)

**Setup:** create a bot via @BotFather → `TELEGRAM_BOT_TOKEN`; message the bot, then read `chat_id` via
`https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_CHAT_ID`. Both live in `.env` (gitignored).

**Wired events (Phase 1):**

| Alert | Trigger |
|---|---|
| 🟢 Kamino Watcher Started | watcher boot |
| ⚡ DUE FOR LIQUIDATION | full scan finds health < 1.0 |
| ⚡ PROMOTED → DUE | hot tick catches a crossing |
| ◉ WATCHING | position enters the hot watch tier |
| ✗ TAKEN (liquidated) | DUE position gone — with `satSeconds` |
| ✗ GONE (managed) | watch-tier position left the band |
| ✓ HEALED | borrower repaid/topped-up |
| ⚑ SURGE MODE ON/OFF | adaptive band activation/clearing |
| 🔔 test | `npm run cli -- alerts-test` |

**Phase 2+ vocabulary (builders ready, wired when evaluator/executor lands):** ▶ EXECUTION ATTEMPT,
⇄ SWAP LEG, 💰 PROFIT CAPTURED (with Solscan link).

**Implementation** (`src/alerts/telegram.ts`): per-kind rate limit (1.5s), 10ms coalesce window,
background send loop with 1 retry, HTML-escaped payloads, injected fetch (unit-tested without
network — `test/telegram.test.ts`). Disabled automatically when env vars are absent.

## Full-market research mode (2026-09-04) + alert noise fix

- **Debt band removed by default** (`--min-debt 0 --max-debt 0`): the watcher now reports across
  ALL debt sizes to measure the true liquidation market and competitor behavior (is it MEV or
  plain bots?). Dust floor $5 keeps hydration sane (8.4K→14.8K accounts, scan ~58s/cycle),
  near-miss snapshot capped at 50 entries.
- **Flapping fixed:** boundary bounce (health oscillating around the 1.02 hot-band edge) caused
  `watching↔taken sat=0s` alert spam. Hot tracker now uses **hysteresis**: a position needs 2
  consecutive above-band ticks before release; hot refresh set widened to all tracked entries
  so the counter can progress. Telegram noise dropped accordingly.
- Set an explicit band back anytime: `--min-debt 100 --max-debt 5000`.

## ARB engine — pivot executed (2026-09-05)

LionX forensic (docs/COMPETITOR_INTEL.md) proved the competitor is an orderflow-insertion operator,
not a pool-to-pool arb we can out-quote; the quote-scanner Sprint 1 was closed after Gate G1 failed
empirically. The track pivoted to the **treasure watcher** (mispriced NEW pools, vault-truth pricing,
5 venues) — BUILT & LIVE in Docker (`treasure-watcher`). Full findings: docs/ARB_TREASURE_RESEARCH.md;
plan: [docs/ARB_ENGINE_PLAN.md](ARB_ENGINE_PLAN.md). Runs alongside the liquidation watcher;
all infra (backoff, alerter, simulate rail, Docker) is shared.

## 👉 NEXT TO DO (in order)

1. **Run the validation-week watcher (NOW, in progress)**

   Docker (recommended, runs detached):

   ```bash
   docker compose up -d kamino-watcher
   docker compose logs -f kamino-watcher      # follow scans
   ```

   JSONL lands in `./data/opportunities.jsonl` (bind-mounted, survives container restarts).
   Run for **3–7 days**. Optionally set `WATCH_INTERVAL` (seconds, default 60) in `.env`.

2. **Analyze the JSONL → go/no-go gate**

   - ≥5 `spotted` opportunities/day clearing the $0.50 profit floor
   - Average `satSeconds` on `taken` events > 60s (means no speed race)
   - Gate passes → build Phase 2. Gate fails → thesis dead; we burned zero SOL.

3. **Phase 2 — Evaluator (Jupiter quote + exact profit math)**

   - `src/strategies/liquidation/swap.ts`: fetch Jupiter `/quote` for collateral→debt swap
   - Net profit = liquidation bonus − swap slippage − flash fee − priority fee
   - Re-rank candidates by *net* profit; raise the floor to cover fee burn

4. **Phase 3 — Executor (simulate-only dry-run)**

   - `src/strategies/liquidation/execute.ts`: assemble `refreshObligation` + `liquidateObligation` + swap inside the existing flash-borrow/repay sandwich (strategy-instruction format, zero core changes)
   - Close-factor math for max liquidatable debt per tx
   - Full-tx simulation; **no broadcast**

5. **Phase 4 — Live (only after 2–3 weeks of profitable dry-runs)**

   - `--yes` flag + hard profit floor ≥ $0.50 + Jupiter min-out enforced
   - Fund bot wallet with <0.5 SOL (ATA rent + fees)
   - P&L daily summary command

## Docker (Phase 1 watcher deployment)

Files: `Dockerfile`, `docker-compose.yml`, `.dockerignore`.

- Image: Node 26 slim, deps installed via `npm ci`, code mounted via tsx at runtime (no build step needed).
- Service `kamino-watcher`: runs `scan --watch --interval ${WATCH_INTERVAL} --log /data/opportunities.jsonl`.
- Secrets come from `.env` (`SOLANA_RPC_URL`) — never baked into the image.
- `./data` is bind-mounted so logs persist across rebuilds/restarts.

```bash
docker compose build
docker compose up -d kamino-watcher
docker compose down            # stop watcher
```

## Risks / honest notes

- MEV bots take medium/large targets — tail coverage is the whole thesis
- Phase 1 profit estimate ignores slippage (upper bound); real numbers in Phase 2
- Income lumpy & volatility-correlated: $2 flat days, $40 volatile days
- Weird collateral/dust debt positions → filter or burn fees on reverts
- Kamino close factor limits per-tx liquidation size (handled in Phase 3 executor math)
