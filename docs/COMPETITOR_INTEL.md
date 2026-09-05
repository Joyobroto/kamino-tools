# Competitor Intelligence — Kamino Liquidations (updated 2026-09-05)

## ⚡ MAJOR UPDATE: LionX is NOT a classical arb bot — it's a Jito-style backrun/insertion operator (or Apex house bot)

Deep forensic of 120 txs (2026-09-05, 00:00 UTC window):

### Cadence & mechanics

| Metric | Value |
|---|---|
| Rate | **~120 tx/hr** (300-sig sample: 300 clean, 0 failed) |
| Gap median | 18s (p90 80s) — continuous opportunity scan, **no batch bursts** (1.2 tx/burst) |
| DEX mix | Apex router 92/120 · + Raydium CLMM 20 · + Raydium CPMM 8 |
| Hops per tx | 1 hop: 48 · 2 hops: 67 · 3 hops: 3 (mostly 1–2 hops) |
| Cost | avg 113,577 CU · 5,417 lamports fee (~$0.0007) · 0% fail rate |
| Liquidations | 0 in sample (liquidation = rare side-hustle) |
| Flash loans | 0 |

### The smoking gun: zero token ownership

**69/120 txs show ZERO net token deltas on LionX's own wallets.** Dissection of no-delta txs
reveals the real game:

```
Tx structure (example):
  User A:  -109.93 X  → +0.0020 WSOL   ← someone selling X, wants SOL out
  User B:  +109.71 X  → -0.2199 Y      ← someone buying X with Y
  User C:  +109.71 Y                  ← recipient
  LionX:   +0.0000 WSOL               ← LION'S DELTA IS ZERO!
  FERjPV…: -0.0020 WSOL               ← another bot side-pays
```

LionX **inserts itself as the counterparty/settlement layer between two users' intents** —
it routes user A's fill through user B's liquidity and captures a micro-spread (the
+0.0020 WSOL one side overpays), settling everything inside ONE tx via the Apex router.
This is orderflow-arbitrage / settlement-insertion, not pool-to-pool arb:

- It does NOT need inventory (net delta = 0 every tx) — no capital at risk
- It does NOT compete for public pool spreads (our Sprint-1 scanner saw 0–0.5bps — consistent)
- It appears in **3/20 sampled txs with Jito program logs** (`Eo7WjKq67…` = Jito), suggesting
  part of its flow is bundled/submitted through Jito for ordering
- 33 distinct counterparties across 20 txs; top ones repeat (HLnpSz9h… in 9/20, 5Q544fKr… in
  7/20) — recurring counterparties = either house wallets or sticky orderflow sources
- Programs: custom `ApexMZD5…` + `LBUZKh…` routers, plus **`cpamdpZ…` = Phoenix** in some txs

### What this means for our strategies

1. **Why our arb scanner sees 0bps**: the majors' spreads are consumed by operators like LionX
   via orderflow insertion BEFORE they ever appear as routeable pool spreads. Classical
   quote-based round-trip arb on majors is largely picked clean. Gate G1 (≥10 opps/day at
   ≥5bps on majors) will likely FAIL — this is the mechanism why.
2. **We cannot copy LionX's core edge cheaply**: their edge is (a) custom router program,
   (b) orderflow access/recognition (likely Mempool/jito-stream or a relationship with a
    front-end/launcher like Apex), (c) Jito bundle submission. Building that = a different
    project (Phase: "orderflow operator"), not a CLI tweak.
3. **What IS copyable for us**:
   - Their **cost discipline** (5k lamports fee, 100K CU) — our execution budget targets the same
   - Their **1–2 hop simplicity** — don't over-route
   - Their **liquidation side-hustle**: they liquidate with the SAME router infra when
     opportunities cross their scan. Our dedicated 10s hot-watch can beat their ~14s cadence.
   - **Phoenix/CPMM venues** they use are worth adding to our Phase-2 swap venues list.
4. **Revised arb thesis**: pure quote-scan arb (Sprint 1) is likely dead on majors; pivot candidates:
   - **Tail/illiquid pairs** the big boys ignore (same long-tail philosophy as our liquidation play)
   - **Event-driven arb** (depegs, listings) — our scanner catches these if we widen the pair list
   - Or accept it: focus our capital strategy on liquidation tail, which IS our differentiated edge.

## Historical sections below (earlier windows, kept for reference)

## Market structure scan (2026-09-04, debt band removed — full-market research mode)

Watcher now runs with `--min-debt 0 --max-debt 0` (band disabled; dust floor $5 for hydration;
near-miss snapshot capped at 50 entries). Hydration shortlist grew 8.4K → 14.8K accounts, scan
58s/cycle — acceptable. Purpose: measure the true liquidation market size and competitor
behavior across ALL debt sizes, not just the tail band.

Early data: near-miss top-50 spans debts $100 → $5.7K, est. profit concentration unchanged
(stable-pair slow-burn positions dominate). Updated intel TBD as data accumulates.

## Historical (first 19h window, 2026-09-03 → 09-04)

> Window: 2026-09-03 06:09 UTC → 2026-09-04 01:49 UTC (~19.6h). Market: calm (SOL flat).
> Method: cross-referenced our 744 watcher snapshots (583 unique tracked obligations) against
> 150 on-chain transactions touching tracked obligations, plus full forensic on every
> liquidation found, plus activity mapping of the dominant bot wallet.

### 1. Missed-DUE events (the blind-window question)

**Exactly 1 position escaped our polling gap in 19.6h** — the one already captured:

| Obligation | Health trail | What happened |
|---|---|---|
| `6qzcv4qA…LHCzbP` | tracked 15.4h at h=1.0015→1.0002 (near-miss #1) | crossed <1.0 and was **liquidated 68s later**, entirely inside one 60s polling gap |

No other tracked position crossed below 1.0 unnoticed. The other 29 positions that vanished
from tracking all left **for non-liquidation reasons** (see §2). **The hot-watch (10s tracker)
deployed after this incident closes this blind window for all future events.**

### 2. Where did the 30 vanished positions go? (classification)

| Outcome | Count | Meaning |
|---|---|---|
| **Liquidated (by external bot)** | 1 | `6qzcv4qA…` — the known event |
| **Self-healed (borrower repay/top-up/close)** | ~11 (on-chain repay/deposit ix confirmed) | borrowers actively manage risk in the 1.05–1.10 band |
| **Drifted out of band** (health rose above 1.10) | ~18 | collateral price recovery / debt accrual slowed; left near-miss, not liquidated |

**Key insight:** most near-miss positions don't die — they get managed by their owners or drift
back to safety. Liquidation conversion of near-miss → DUE is the **rare event** (1/583 in 19.6h
in a calm market).

### 3. Liquidation economics — the 3 captured events

| When (UTC) | Obligation/debt | Repaid | Collateral seized | Bonus | Bot profit (est) | Fee |
|---|---|---|---|---|---|---|
| 09-03 21:36 | `6qzcv4qA` $103.07 FDUSD | 10.32 FDUSD | 10.43 USDS | 1% (min bps) | **~$0.13** | 25,840 lamports |
| 09-04 00:05 | (untracked — blind to us) | 1.36 (SOL-denom) | 13.20 (SOL-denom) | ~1% + fees pattern | ~$0.007 SOL (~$1?) | 5,541 lamports |
| 09-04 01:00 | (untracked — blind to us) | 3.26 | 4.26 | ~1% | ~$0.01 SOL (~$1.5?) | 5,387 lamports |

**Honest read:** every captured liquidation in this window was profitable but TINY (~$0.10–1.50).
These are exactly the tail positions our thesis targets — and the incumbent bot(s) take them
**within ~68 seconds**.

### 4. Competitor map

| Bot wallet | Behavior | Verdict |
|---|---|---|
| `LionX7R69tL1EEcpRkJ9jRuwV7bi4jFoKmZZnxiVK6y` | **The dominant liquidator.** ~3,000 txs in 11.5h (~260 txs/hr, one every ~14s). Of 30 sampled non-liquidation txs: 29 pure swaps — this is a **multi-strategy swap bot that ALSO liquidates** opportunistically. All 3 liquidations in our window were theirs. | Primary competitor — DEX-to-DEX arb machine (see deep-dive above) |
| `9DrvZvyW…` (flash-borrow side wallet in event 1) | Zero activity outside the liquidation txs — a dedicated flash-loan wallet paired with LionX | LionX's auxiliary |
| Others | None observed in window | — |

### 5. Strategic implications for us

1. **Speed bar is real but low:** the incumbent reacts in ~68s. Our hot-watch (10s) is ~7x faster.
2. **Calm-market pool is small:** ~3 liquidations/19.6h × ~$0.10–1.50 = under $5/day in these conditions.
3. **One-bot field = opportunity:** a dedicated hot-watch executor can take share. Their arb
   playbook (multi-pool hops, USDC settlement) is the blueprint for our Phase 2/3 swap leg.
4. **Watch for LionX's wallet in our logs.**
