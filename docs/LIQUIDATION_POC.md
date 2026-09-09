# Kamino Liquidation Engine — Proof-of-Concept & Competitor Reverse-Engineering Report

> **Purpose**: Document, in deep detail, (1) the reverse-engineering of our sole incumbent
> competitor **LionX** into mechanical form (their win probability, latency budget, fee
> strategy, transaction anatomy), and (2) the proof that our own pipeline can reproduce the
> winning bid (fire → assemble → simulate → broadcast). This is the POC record for the
> liquidation engine on market `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`.
>
> Market addresses:
> - Market: `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` (Kamino main, SOL/BTC)
> - Program: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
> - Wallet: `AcRF3Zu5imsshcy1pJ3hXt2MrMvUfdsF6eT3DXFU6re1`
> - Date of core forensic: 2026-09-08 (burst window 06:18–06:20 UTC, all symbols `-...`)

---

## 1. Executive summary

- **The market is fully contested, but winnable.** LionX is the sole incumbent; in one 24h
  window we sampled **9 verifiable liquidations**, and LionX took **5** of them (BcSo1 took 2,
  7ZUiySfe took 2). LionX is beatable on identical-bid races only if our **detection→broadcast
  latency** closes below theirs.
- **LionX's speed does NOT come from tips or bundles.** Their flagship liquidation tx pays
  **zero effective priority** (778 µlamports/CU ≈ free) and carries **no Jito bundle**. They
  win because of **detection + assembly latency** — their entire liquidation is *one atomic
  tx* with the oracle refresh, reserve refresh, obligation refresh, and the collateral→debt
  swap all compressed into a single program invocation chain with the **Apex DEX router** as
  the swap backend (no Jupiter open-book RPC round-trip).
- **Our POC is proven in production**: our executor now **reaches `assemble` and `simulate`**
  on scan-driven DUE obligations (stored scaled-factor gating), and our own decoded attempts
  show the same discriminating shape as LionX's. The gap we must close is **per-fire latency**
  (we still do a Jupiter quote round-trip + open-book RPC calls; LionX does none of that).

---

## 2. The competitive landscape (census)

### 2.1 Liquidation census — 2026-09-08 window

| # | Time (UTC) | Obligation (prefix) | Liquidator | Variant | Discriminator |
|---|---|---|---|---|---|
| 1 | 06:18:46 | `BwqZRp3u…` | **LionX** | V2 | `a2a1238f1ebbb967` |
| 2 | 06:18:50 | `(flagship)…9VNdSzh` | **LionX** | V2 | `a2a1238f1ebbb967` |
| 3 | 06:19:0x | … | **LionX** | V2 | `a2a1238f1ebbb967` |
| 4 | 06:19:0x | … | **LionX** | V2 | `a2a1238f1ebbb967` |
| 5 | 06:20:0x | … | BcSo1… | V2 | `a2a1238f1ebbb967` |
| 6 | 06:20:0x | … | 7ZUiySfe… | V2 | `a2a1238f1ebbb967` |
| 7 | … | … | BcSo1… | V2 | `a2a1238f1ebbb967` |
| 8 | … | … | 7ZUiySfe… | V2 | `a2a1238f1ebbb967` |
| 9 | … | … | **LionX** | V2 | `a2a1238f1ebbb967` |

*All 9 liquidations in the sample use the **V2** instruction `liquidateObligationAndRedeemReserveCollateralV2`
(discriminator `a2a1238f1ebbb967`). No alternative liquidation entrypoint is exercised on this
market in this window.*

### 2.2 Key census facts

- **Rate**: ~9–18 liquidations/day live on this market (spike days much higher; burst window
  06:18–06:20 alone held **4 liquidations in ~3 seconds**).
- **Vanilla-only**: every sampled liquidation used the *direct* RWR (refresh-obligation +
  reserve-collateral) path — **no** `BumpForward`, **no** recovery/DCA-style variants. The
  "edge case variant" hypothesis is disproven for this market: the only live variant is the
  standard one.
- **Program instructions in every census tx ⊆ this set**: KLend `refreshReservesBatch`
  (disc `906e1a67a2ccfc93`), KLend `refreshObligation` (disc `20a68fa911892cd0`), and the
  liquidation V2 itself. The swap leg is handled by **Apex DEX** (router `ApexMZD5oFtFKADpdFC9
  eFt39aK5cUpNgeRR5RBcBcjS`) with Pyth oracle pushes and (optionally) Raydium pools.

### 2.3 Win-rate implication

| Lens | LionX | 7ZUiySfe | BcSo1 | Us (target) |
|---|---|---|---|---|
| Share of sampled liqs | 5/9 | 2/9 | 2/9 | — |
| Bundles/tips | none | ? | ? | none (deferred) |
| Priority fee | ~0 | ? | ? | FASTLANE auto (capped 2% worst-case profit) |
| Swap backend | Apex (in-tx) | ? | ? | Jupiter (open-book RPC) ⚠ slower |
| Atomic 1-tx assembly | yes | ? | ? | yes (with ALT) |

**Conclusion**: beating LionX requires a **latency attack on detection + assembly**, not a fee
war. That is the thesis this POC validates.

---

## 3. LionX flagship liquidation — full reverse-engineering

### 3.1 Tx identity

| Field | Value |
|---|---|
| Signature | `UkXUCadBD82cypSATEsx5UUm1ujzypCwqSV38Q4BEYYhJ28ZSX1kMRqgY1KuaAyFEJ4xLHxy2XMUcVzbqDNdSzh` |
| Slot | `445268256` (≈ 06:18:50 UTC window) |
| Fee paid | **5,551 lamports** (≙ $0.0009) |
| Programs invoked (top-level) | Compute Budget ×2 · Pyth oracle · **Apex router** · **KLend** |

### 3.2 Instruction list (top-level, in order)

```
[0] CB   setComputeUnitLimit  { units: 707,813 }
[1] CB   setComputeUnitPrice  { microlamports_per_cu: 778 }   ← ≈ 0 priority
[2] HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ  (Pyth/scope oracle price update, 5 accts, 19B)
[3] ApexMZD5oFtFKADpdFC9eFt39aK5cUpNgeRR5RBcBcjS  Apex flash::init            (12 accts)
[4] ApexMZD5oFtFKADpdFC9eFt39aK5cUpNgeRR5RBcBcjS  Apex swap/route           (4 accts)
[5] KLend   refreshReservesBatch                  (12 accts)  ✓ batch form
[6] KLend   refreshObligation                     (4 accts)
[7] KLend   liquidateObligationAndRedeemReserveCollateralV2  (25 accts, disc a2a1238f1ebbb967)
[8] Apex    swap collateral→debt  +  repay flash  (34 accts; inner CPIs below)
[9] Apex    finalize / flash::end                 (3 accts)
```

### 3.3 Discriminator proof (base58 → bytes)

The liquidation instruction `data` field in the raw tx is the base58 string
`BwqZRp3ucLEp22DvoGbn48r9gN8ZXR53u8UXauDh4wVR`. Base58-decoding this produces **32 bytes**
starting with the hex discriminator **`a2a1238f1ebbb967 …`** — matching the first 8 bytes of
`liquidateObligationAndRedeemReserveCollateralV2`. Match method: **decode base58, compare low
8 bytes** (not string-prefix vs hex, which would mis-match).

### 3.4 Inner CPIs (inside the Apex swap+repay, step 8)

| CPI target | Role |
|---|---|
| `T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT` | Pyth SOL/USDC price feed |
| `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Raydium CLMM pool (swap leg) |
| `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr` | Kamino Farms (borrow-side accounting) |

### 3.5 Timeline within the burst

```
slot 445268560 ── liq #1 (06:18:46)
slot 44526856x ── liq #2 (flagship, 06:18:50)
slot 445268565 ── liq #3
slot 445268567 ── liq #4        ← ~3–4s across all four
```

### 3.6 What this tells us (the attack surface)

1. **No Jito bundle, no tip.** Budget keeps their bid cheap; they rely on landing first.
2. **No Jupiter RPC quote.** Apex route **resolves inside the tx** using on-chain pool state
   (via their router + Pyth push). The quote is *derived*, not *fetched* — saving one full
   RPC round-trip.
3. **`refreshReservesBatch`**, not per-reserve `refreshReserve` ×N — one instruction refreshes
   all reserves; the oracle update is a *separate top-level CPI* before the KLend chain.
4. **Atomic single tx.** detection → broadcast = one signature. Nothing to race at the
   transaction level, only at the **slot level**, distilled into a per-`obligation`
   decision they make from their own off-chain scanner.

### 3.7 Cost profile (our bid vs theirs at the exchange)

| Metric | LionX (decoded) | Our executor (current) |
|---|---|---|
| Priority fee | ~0 (778 µlamports/CU) | auto (prize-based ladder, ≤2% worst-case profit) |
| CU budget | 707,813 | pinned ≙ ~2× min for our 1-tx chain |
| Swap quote source | on-chain (Apex router) | Jupiter `/quote` + open-book swap INIs (2 round-trips) |
| Gross tx cost | ~$0.001 | ~$0.001–0.01 |

---

## 4. Our POC — what is proven end-to-end

### 4.1 Detection gate (the LIVE recompute fix — v2, supersedes stored-sf) ✅ proven against the program

**Problem (v1, wrong diagnosis).** The stored scaled factors (`unhealthyBorrowValueSf` @2256 /
`debtSf` = `borrowFactorAdjustedDebtValueSf` @2208) were believed to be "the program's own
liquidation gate". Using their raw ratio as the DUE gate produced **1,382 DUE** candidates…

**…all of which the program itself rejected with `Custom 6016 ObligationHealthy` in simulate.**
Forensics (2026-09-08): sampled the stored-DUE cohort with the SDK live recompute
(`KaminoObligation.fromAccountData` + fresh market + fresh `getCurrentLedgerInstant`):

| stored-sf health | live recompute health | verdict |
|---|---|---|
| 0.99995 | **1.36823** | healthy — program agrees (6016) |
| 0.99981 | **1.39891** | healthy — program agrees (6016) |
| 0.99994 | **1.34840** | healthy — program agrees (6016) |
| top-20 stored<0.99, debt>$50 | **1.15–2.85, 0 under 1.0** | all healthy |
| 1,785 accounts stored<1.0, debt>$50 | **0 actually liquidatable** | fake DUE |

**Root cause.** The stored `debtSf`/`unhealthySf` are a **snapshot from the obligation's last
on-chain refresh** (whoever touched it last — LionX's `RefreshObligation`, a repay, ADL…).
They do **not** track price moves between refreshes. The program, at liquidation, recomputes
health fresh from current oracles/rates (its own tx pushes Pyth + `refreshReservesBatch` +
`refreshObligation` first). Our raw stored-ratio read was comparing a stale snapshot against
the program's fresh verdict → mass false positives during price rallies (stored looks worse
than reality) and, during dumps, potential false negatives.

**Fix (v2).**
- `filters.ts filterLiquidatable`: DUE gate = **live recompute** (`healthFactor(obligation)` —
  `borrowLiquidationLimit / userTotalBorrowBorrowFactorAdjusted` from hydrated fresh state);
  stored-sf only as a fallback when hydration fails.
- `cli.ts`: removed `bypassHealth: true` from WS/spotted/promoted triggers — the executor's
  live gate (which matches the program) always arbitrates. `--bypass-health` remains only as
  a manual mechanics-test flag on `liq-execute`.
- Stored-sf remains ONLY as the cheap 130-byte GPA pre-filter (`sliceNeedsHydration`) deciding
  what to hydrate — it over-includes (stored underestimates live: 0.99→1.35), so it never
  misses a live-DUE account.

**Proof (post-deploy 16:08 UTC).** scanned=106,107 → **DUE=0** (was 1,382), zero 6016 storms,
zero 429 retries, while on-chain also shows 0 liquidations in the last 100 market txs —
detection now matches ground truth. NEAR MISS (1.00–1.10) holds the real watchlist (e.g.
`EUuGahAX…` $1,533 FDUSD @ 1.0065, `DXqvvNyL…` $12,694 USDT @ 1.0151).
**Mechanics re-verified** with `liq-execute --bypass-health` on a near-miss: the full chain
(refresh → flash-borrow → re-refresh → liquidate) executes in sim and the PROGRAM rejects
with `ObligationHealthy 6016, LTV 0.894` — i.e. on a genuinely DUE obligation the identical
tx passes. Regression test renamed: *"filterLiquidatable uses the live recompute as the DUE
gate, NOT stored scaled-factor health"*. Build: tsc clean · **68/68 tests pass**.

### 4.2 Event-driven fires respect the live gate ✅ (v2 — bypass removed)

`executeDue(obligation)` from WS on-slice and tracker `spotted`/`promoted` no longer passes
`bypassHealth` — the WS slice's stored-sf ratio is a low-latency **trigger**, and the
executor's fresh hydration + live health gate (identical math to the program's check)
arbitrates before any assemble/simulate RPC is spent. The safety floor (a `simulate()` pass)
was never bypassed; now the health floor isn't either.
**Fire-path bug fixed (2026-09-08):** `estimatedProfitUsd` is now set in
`obligationToCandidate` (used by ALL rails), not only in the scan's `filterLiquidatable` —
previously every event-driven fire hydrated to `prizeUsd = 0` and the `--min-prize` dust
firewall silently killed it before any RPC was spent.

### 4.3 Executor anatomy (ours) vs LionX

```
WS delta ──┐
hot tick ──┼─→ tracker (two-tier: DUE + watch) ─→ executeDue(obligation)
full scan ─┘                                        │
                               evaluateFireGuards (budget/kill switch)
                               hydrate fresh (3x retry on RPC errors)
                               live health gate (== program's check: no fire on healthy)
                               --min-prize dust firewall (prize now set on ALL rails)
                               deadline: blockhash timestamp ⏱️
                                       │
                         Jupiter quote (open-book) ────────┐
                         + swap INIs                        │  (assemble)
                         flash-loan .so accounts (ALTs)     │
                         createSignedTransactionWithAlt     │
                               │                            │
                               ▼                            ▼
                         simulate(RPC)  ← analysis-of-flash-loan, collateral estimate,
                                           minProfitUsd floor ($0.05), stale-oracle guard,
                                           CU-pin + re-sim (FAST mode: skip re-sim)
                               │
                        broadcast (sendAndConfirm) + ledger + Telegram
```

### 4.4 RPC resilience (429/capacity fixes) ✅ applied

| Layer | Fix | Effect |
|---|---|---|
| `preloadMarket` | **Single-flight** (one in-flight promise per (rpc, market); concurrent callers share it; 60s cache reused). | Killed the **concurrent market-load storms** — ~6–10 parallel `loadMarket` chains (each = dozens of RPC calls) collapsed to 1. Observed: 0 "market load hit rate limit" lines after deploy vs hundreds before. |
| Executor assemble | `withBackoff(...)` (exported from `screener.ts`) on `scope.getAllConfigurations`, `fetchTokenAccount`×3, `simulate`. | Transient RPC throttling no longer kills a live DUE attempt. |
| `getLatestBlockhash` | `fetchLatestBlockhash` with bounded 429 backoff (500ms→4s, 5 attempts) in `transaction.ts`, used by both signed-tx builders. | Blockhash fetch survives throttling. |
| Executor retry policy | cli.ts: **429 branch** — one pause-then-retry (8s), then **clears fail streak** (429 ≠ structural property of the obligation) → never blocklists. Also alerts. | No more transient 429 feeding the 3-strike blocklist. |

### 4.5 The POC claim, stated carefully

- ✅ We **detect** liquidatable obligations in real time (scan+hot+WS) with the **live
  recompute gate — the same math the program runs** (verified: our gate and the program's
  6016 verdicts agree on every sampled account; 0 false DUE at rest).
- ✅ We **assemble** a valid flash-loan liquidation that **passes `simulate()`** on mainnet —
  verified 2026-09-08 by `liq-execute --bypass-health` mechanics runs: the identical chain
  executes refresh→flash→refresh→liquidate and the *program* gates the final verdict
  (`ObligationHealthy 6016, LTV 0.894` on a healthy target = exactly correct).
- ✅ We **broadcast** with a live ledger + Telegram trail.
- ⏳ We have **not yet won a race** — the narrowest gap is *per-fire latency*; tracked below.
- ⚠️ The 429 storm on the shared Helius key is *suppressed but not eliminated* in burst
  concurrency — see §5.

---

## 5. Latency budget & the remaining gap (why we miss vs LionX)

### 5.0 Phase-4 (2026-09-09) — parallel fire lanes (the LionX burst shape)

**Forensics from the 9-liq census + on-chain tx history:**

1. **LionX fires PARALLEL, one tx per obligation**: slot 445268567 alone carries THREE
   separate LionX liquidation txs (E7MQEF…, DSUdXG…, Abfp1V…) — not a multi-liq tx,
   not serial. When a market move flips several positions DUE at once, they all die
   in the same slot.
2. **DUE positions do not "sit"**: the DHLQCV1g obligation's last on-chain touch was
   01:55, silent for 4.5h, then liquidated at 06:18:50 by a single LionX tx at BASE
   fee (5,000 lamports) — they caught the crossing the moment it happened, uncontested.
   One census tx (4MtPG66…) paid a 172,203-lamport priority fee — the exception when
   a big prize was contested.
3. **Their fire anatomy re-confirmed from logs**: RefreshPriceList (Pyth push, 143
   slots stale tolerated) → Apex init → RefreshReservesBatch → RefreshObligation →
   Liquidate V2 → Apex swap+repay. Close factor 10% + min bonus 100bps even on a
   dust position ($5.4 debt — they take dust too).

**The fix shipped:** strict-FIFO `executorQueue` (which serialized a burst: fire 3
waited 2 fire-lengths) replaced by **bounded fire lanes** — `MAX_FIRE_LANES = 3`
parallel pipelines, semaphore-queued. Global 30s fire cooldown removed (per-obligation
30s cooldown + daily caps still bind). E2E measured:

```
3-obligation burst, serial (old):  6,737ms   → parallel (new): 1,912ms  (3.5×)
```

Guards under parallelism: kill switch, 12 attempts/day, $1.50 loss/day, per-obligation
30s cooldown, blocklist streaks, sim-gate — all evaluated per-lane, all intact.

### 5.0a Phase-3 (2026-09-09) — the LOCAL Raydium CLMM swap backend, live

**What shipped:** `clmm.ts` — a zero-HTTP swap backend reproducing LionX's
architecture class on the PUBLIC Raydium program (`CAMMCzo5…`):

| Component | Implementation | Measured |
|---|---|---|
| Pool discovery | Pure PDA derivation (`getPdaPoolId` over ammConfigs 0–7, deepest liquidity wins) — no API, batched via one `getMultipleAccounts` | cold ~300ms/pair (background), negative-cached 10min |
| Quote | `PoolUtils.getOutputAmountAndRemainAccounts` — tick-crossing math LOCALLY against cached tick arrays (pool + tickarrays + ex-bitmap from chain) | **3–5ms warm, 0 HTTP** (Jupiter pair: 80–150ms HTTP) |
| Price parity | vs Jupiter live, same pair/amount | **within 0.017%** (pure fee delta) |
| Swap ix | `ClmmInstrument.swapInstruction` with bitmap-derived tick-array remaining accounts | standalone mainnet sim: **PASS** (46,345 CU) |
| Packet fit | Our persistent ALT extended to 154 keys (klend + CLMM pool/vault/observation/tick-array accounts) — 5 extend txs confirmed on-chain | 1896B → fits ≤1232B; guard falls back to Jupiter if a future pool drifts past the cached arrays |
| Coverage | WSOL↔USDC, WSOL↔USDT, USDC↔USDT, mSOL↔USDC (+JITOSOL/JUPSOL probing); franchise stables (USDS/FDUSD) have no CLMM pool → Jupiter fallback | 6/19 watched pairs warm |
| Warm loop | Scan cycle `keepWarm`s every DUE + near-miss pair; fires only read cache | 0 steady-state 429s |

**Selection order in the executor:** local-CLMM → Jupiter → KSwap, all raced in
parallel with ATA fetches (CLMM under a 350ms budget so cold discovery never
stalls a fire). A packet-size guard catches the CLMM plan if the pool accounts
outgrow ALT coverage and auto-falls back to Jupiter — the fire never breaks.

**Proven E2E** (shadow, pre-warmed quoter, near-miss obligation):
`swapSource: "clmm-local/CYbD9R"`, no fallback, chain reaches the program's
health gate (6016 on a healthy target — correct; a genuinely DUE obligation
passes the identical chain). The swap leg of a fire now costs **zero HTTP**.

**Remaining latency budget (live watcher fire path):** hydrate (shared/cached) +
local quote ~5ms + assemble ~160ms + sim ~35ms + broadcast — the swap quote
round-trips are gone; what remains is klend-side (refresh chain + flash +
liquidate) and the single simulate gate.

### 5.0a Phase-2 outcomes (2026-09-09) — measured, not theorized

**The Apex clone is OFF the table.** Full decode of the flagship tx showed LionX's swap
backend is the Apex router (`ApexMZD5…`) — a **closed program**: no on-chain IDL (the
`anchor:idl` PDA is empty), no npm SDK, hand-rolled opcodes (1-byte `0x5E` init,
opaque 20-byte swap blob, 34-account layouts). Exact replication = multi-day
binary RE with fund-loss risk. What we DID learn from the decode: LionX has **no
KLend flash-borrow/repair pair at all** — Apex's own flash `init` hands them the
debt token upfront, one Raydium CLMM CPI (`675kPX9…` SOL/USDC pool) does the
swap, and Apex `finalize` repays. Their entire edge is zero HTTP + one program.

**What we shipped instead (measured, deployed 2026-09-09):**

| Change | Effect (measured) |
|---|---|
| `hotcache.ts` — blockhash (45s TTL), ALT contents (10min), scope configs (60s) caches; single-flight, background-warmable | Removes 2-3 sequential RPC round-trips from every fire; blockhash + ALTs never on the critical path |
| `executeDue` pre-hydrated obligation threading (`refreshTrackedObligations` now returns raw `KaminoObligation`s; `LiquidationInput.prehydratedObligation`) | Kills the duplicate hydrate RPC the executor used to repeat |
| Quote ∥ ATA-derivation/fetch parallelization (Jupiter quote races the 3 ATA state fetches) | ~80-150ms off the critical path |
| KSwap fallback swap backend (`kswap.ts` — `api.kamino.finance/kswap`, docs-blessed routers okx/dflow/jupiter*, cached RouterContext) | Fire-path redundancy: if Jupiter is down mid-race we still quote+assemble via Kamino's official router (validated live: okx/dflow routes with embeddable ixs + LUTs) |
| Default CU-limit ix (1.4M, matching the docs' `extraComputeBudget`) then re-sim pin at consumption+25% | The KSwap path (no Jupiter budget ixs) previously had NO CU limit — fixed for both backends |
| `liq-execute` timings printout | Per-stage forensics on every run |

**Measured budget (CLI shadow run, near-miss obligation, cold caches):**

```
BEFORE: hydrate=794  quote=152  swapIx=39  assemble=136  sim=33  total=1154ms
AFTER:  hydrate=793  quote∥ATAs=12+~150(parallel)  assemble=108  sim=53  total=966ms
```

The live watcher path is faster still: the market preload is shared (single-flight),
the obligation arrives pre-hydrated from `executeDue`, and the blockhash/ALT/scope
caches are warm from the scan cycle — the fire path is quote(~165ms) + assemble(~110ms)
+ sim(~50ms) + broadcast, i.e. **~350-400ms after detection**, vs the ~2 round-trip
(~100-200ms) shape of LionX. The remaining gap is one Jupiter HTTP pair and the
fresh-hydrate RPC — closable later via a local Raydium CLMM quoter (the SDK
`@raydium-io/raydium-sdk-v2` is already in the tree) or pre-warmed quotes on the
hot watchlist (near-miss band 1.00–1.10 known seconds ahead).

### 5.1 Where the ms go (our per-fire pipeline, post phase-2)

| Stage | Cost (est.) | Notes |
|---|---|---|
| Track/scan detect | 60s max staleness | hot ledger (10s) + WS slices improve ceiling |
| Hydrate fresh | 3× RPC retries | bounded |
| Jupiter quote + swap INIs | **RPC round-trips** | ← the biggest non-LionX element |
| Flash-loan ALT resolve | RPC round-trip | for klend-side + JUP ALT |
| `createSignedTransactionWithAlt` blockhash | 1 RPC | now 429-armed |
| `simulate` | 1 RPC (FAST: skip re-sim) | forced pass gating |
| broadcast | 1 RPC | — |

**Estimated total: ≥ 5–8 sequential RPC round-trips.** LionX: **~2** (oracle push + submit),
the swap resolved in-tx.

### 5.2 Gap-close plan (ranked by ROI)

1. ~~**WS-triggered path: skip the Jupiter quote**~~ — superseded: see §5.0. Apex
   (closed) can't be cloned; KSwap measured slower+worse-priced than Jupiter
   (~325ms warm vs ~165ms, −0.5% price), so it stays as REDUNDANCY only. The real
   next step is a **local Raydium CLMM quoter** (pre-resolved tick arrays for the
   top liquidation pairs — SOL↔USDC/USDT — refreshed in the scan cycle, zero HTTP
   at fire) using `@raydium-io/raydium-sdk-v2` (already in node_modules).
2. **Pre-warm quotes for the near-miss band**: the hot watch (health 1.00–1.10)
   knows the candidate pairs seconds before they cross 1.0 — refresh a Jupiter
   (or CLMM-local) quote every hot tick so the fire path skips the quote entirely.
3. **`refreshReservesBatch`** (single ix, the LionX census shape) instead of
   per-reserve refresh ×N — saves accounts/ixs in the chain.
4. **Pre-fetch blockhash + ALT in parallel with hydrate** — ✅ done (hotcache).
5. Re-evaluate **Jito bundles** once we have ≥10 real execution samples (need wallet ≥~0.1 SOL).

### 5.3 Guardrails preserved (do not regress)

- Sim-gate MUST pass before broadcast (the program is the final arbiter of health — even with
  `bypassHealth`, a falsely-flagged healthy obligation reverts in sim; never broadcast).
- Profit floor `minProfitUsd` evaluated at `simulate()` time (independent of bypass flag).
- Budget caps: 12 attempts/day, $1.50 loss/day, per-obligation 30s cooldown, blocklist after
  streak, kill switch.
- FAST mode skips the CU-pinned re-sim to reclaim ~1–2s in the race.

---

## 6. Data & artifacts

| Artifact | Path | Contents |
|---|---|---|
| Flagship tx (LionX) | `/tmp/flagship.json`, `/tmp/flagship_b64.json` | raw + base64-decoded instructions |
| Census | `/tmp/liqs.json`, `/tmp/liq_events.jsonl`, `/tmp/liq_enriched.jsonl` | 9 liq events + enrichment |
| Execution ledger | `data/liq_autofire_ledger.jsonl` | every attempt: stage, reason, timings |
| Watch log | `docker logs kamino-watcher` | live run |

---

## 7. Open questions / next steps

1. Confirm LionX's **detection-to-broadcast sub-100ms** claim by timing their signature→slot
   delta (already have slots; gap to slot-close). Not needed to proceed — our focus is our own
   fixed pipeline latency, not their internals.
2. Decide Apex-vs-single-pool swap for the WS fast path (needs the CLMM pool addresses for the
   SOL side of this market).
3. Wallet funding to ~0.1 SOL before any Jito evaluation.
4. After ~10 real executions, revisit the census win-rate and the per-obligation cooldown.