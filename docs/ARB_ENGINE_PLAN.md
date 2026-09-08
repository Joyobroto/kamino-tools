# ARB Engine Development Plan — "LionX Versi Kita"

> Status update (2026-09-05, evening): **quote-scanner thesis CLOSED, treasure-watcher LIVE.**
> Gate G1 (≥10 opps/day at ≥5bps on majors) failed empirically — the majors' spreads are consumed by
> orderflow-insertion operators (see docs/COMPETITOR_INTEL.md "smoking gun" section). The `arb-scan`
> command + its Docker service have been RETIRED; the CLI command remains for manual spot checks.
> The arb track pivoted to the **treasure watcher** (mispriced NEW pools, vault-truth pricing):
> docs/ARB_TREASURE_RESEARCH.md + `treasure-scan` command + `treasure-watcher` Docker service (LIVE).
> Principle: **modal sendiri dulu, flash-loan opsional belakangan.** Kita tiru yang terbukti menghasilkan, bukan yang eksotis.

## Sprint 1 — RETIRED (quote scanner)

Built 2026-09-04, ran ~20h in Docker, produced 11 opportunities total (6 above 5bps) — below the
G1 gate by an order of magnitude. Root cause understood via LionX forensic + Uyar121 playbook
research: classical quote-visible arb on majors is picked clean before it becomes routeable.
Deliverables kept (reusable): `quotes.ts` (Jupiter lite + backoff), `spread.ts` (round-trip math),
`types.ts`. Scanner code retained in `scanner.ts` for the `arb-scan` CLI; Docker service removed.

## Sprint 1c — LST depeg verdict engine (BUILT & SIMULATION-PROVEN, 2026-09-06)

The "no guessing" loop the whole engine exists for: any detected discrepancy is now provable
atomically with ZERO capital before a single lamport is broadcast.

**Flow (`npm run cli -- lst-execute --symbol JitoSOL --size 500`):**
1. Kamino oracle rate (Pyth, from the Main-market reserve — same source the flash loan repays against)
2. Jupiter 2-leg plan: borrow LST → sell for SOL (market) → buy LST back → repay principal+fee
3. Both legs fetched as real `/swap-instructions`, embedded into the flash-borrow/repay sandwich
   (ALT-compressed v0 tx, duplicate-instruction dedupe, reserve-ATA filter)
4. **Mainnet simulation runs the whole sandwich** — the verdict is the sim result:
   repay succeeds ⇔ the depeg is real and executable
5. Broadcast stays gated behind `--yes` + `--min-profit` (still deliberately hard-locked)

**Empirical first results (calm market, 2026-09-06):**
- JitoSOL: oracle 1.299782 vs market 1.2996-1.2997 SOL → spread 1-4bps → round-trip returns
  LESS than the borrow → **plan correctly fails fast**: "spread too thin; needs a real depeg"
- JupSOL: oracle 1.207663 vs market ≈1.2076 → same efficient-market verdict
- The simulation previously reached FlashRepay and failed with `insufficient funds` on exactly
  the thin-spread case — proving the failure mode is caught atomically (no partial state,
  no capital burned; simulation is free)
- On a real depeg day (oracle/market gap ≥ ~15bps + swap costs), the same command prints
  quoted P&L, worst-case P&L, and `EXECUTABLE YES/NO`

**The full pipeline stack now:** watcher detects → oracle-vs-market spread → depth-probed →
2-leg plan (profit-gated, fail-fast) → atomic flash-loan sandwich → mainnet simulation →
only then broadcast. Every stage is measurable; nothing is guessed.

## Sprint 1b — Treasure watcher (BUILT & LIVE, 2026-09-05)

Replacement strategy validated by on-chain research (docs/ARB_TREASURE_RESEARCH.md):

- Detect **newly created pools** (GPA diff, ~200/hour, 5 venues: pumpswap, DAMMv2, DLMM, CLMM, Whirlpool)
- Price from **live vault balances only** (aggregator caches proven up to 200,000x stale)
- Ghost-liquidity filter (ANB case: "$240K pool" held $8.51), honeypot guard (mint/freeze authority)
- Compare pool price vs Jupiter reference → alert ≥5% discount → Telegram + JSONL
- First live results: fresh pumpswap pools list 5–9% below Jupiter reference (migration pattern)
- **Depth-gate update (2026-09-06):** forensic re-check showed 46/46 first-night events were
  mirages — Jupiter's "reference" for fresh mints routes through sniper-seeded dust pools
  (<$1). The scanner now probe-sells the reference (`checkReferenceDepth`, $100 probe,
  ≥80% out) before alerting. All pumpfun-migration discounts fail this gate (expected);
  a real two-market treasure would pass it.

Files: `venues.ts` (verified pool layouts), `pools.ts` (feed + vault pricing), `treasure.ts`
(ghost filter + opportunity math), `scanner.ts` (`scanTreasurePass`), CLI `treasure-scan`,
Docker `treasure-watcher`. Tests: venue decode, SPL account decode, mint safety, ghost filter,
opportunity math, price formatters (70/70 green).

**Validation gate (2 weeks of JSONL):** how often, how big, how long does the discount persist?
Executable size = f(vault SOL side) — flash-loan Sprint 2 stays gated on that data.

## 0. What LionX actually does (forensic, 2026-09-04 — docs/COMPETITOR_INTEL.md)

| Aspect | LionX behavior | Our read |
|---|---|---|
| Cadence | ~260 tx/jam, ~14s/tx, 24/7 | scan-opportunity-execute loop kontinu |
| Core op | 59/60 sampled txs = pure swaps | arb DEX-to-DEX adalah mesin utamanya |
| Profit pattern | net USDC inflow +0.0006–0.0020 per tx | volume game: banyak tx × margin kecil |
| Venues | Raydium CLMM + Raydium CPMM + Orca Whirlpool | 3 DEX cukup — bukan semua DEX |
| Routing | custom router programs (`ApexMZD…`, `LBUZKh…`) — BUKAN Jupiter v6 publik | routing in-house = hemat compute & biaya ix |
| Capital | own funds, **no flash loans** di arb flow | dia bawa inventory sendiri |
| Cost | 51–77K CU, fee 5000 lamports/tx | execution murah = margin tipis tetap positif |
| Kamino | liquidation = side hustle pakai swap infra yang sama | ops jam 21:36 via `RefreshObligation → LiquidateV2 → swap` |

## 1. Strategy scope (what we build, in order)

### ~~Sprint 1 — Quote scanner~~ → CLOSED (G1 failed; replaced by Sprint 1b treasure watcher above)

**Goal (original):** bukti ada spread yang bisa diambil, SEBELUM nulis eksekusi.

- ~~Poll Jupiter Quote API~~ (kept for reference quotes + SOL price)
- **Result:** majors 0–0.5bps round-trip; orderflow operators consume the rest pre-quote. Gate G1 FAILED → pivot.

### Sprint 2 — Executor (modal sendiri, size kecil)
**Goal:** eksekusi atomic A→B→A dalam SATU tx (bukan dua tx — itu yang bikin LionX untung: no leg risk).

- Route via Jupiter swap API (ambil route map + bangun ix sendiri) ATAU `@raydium-io/raydium-sdk-v2` + `@orca-so/whirlpools` untuk hop langsung antar 3 DEX itu (hemat CU seperti LionX).
- Compute budget ix + priority fee dinamis (CU cap 300K, fee sesuai congest).
- Min-out enforcement di tiap hop (slippage protection) — profit floor hard-gated SEBELUM sign.
- Simulate dulu (rail yang sama dengan flashloan CLI: `simulate` sebelum `execute`).
- Wallet arb khusus: seed $50–200 USDC. **Bukan wallet liquidation.**
- Mode dry-run: log "would-have-profit" 2–3 hari sebelum broadcast nyata.

### Sprint 3 — Inventory management + feedback loop
- Settle semua route ke USDC (copy LionX: USDC = unit of account).
- Inventory ledger per mint di `data/arb_inventory.jsonl` (avg entry, realized P&L per route).
- Auto-blacklist route yang 2× gagal/negatif setelah eksekusi.
- Metrics harian: tx count, gross/net, win rate, CU cost — masuk Telegram alert harian (💰 vocabulary sudah ada).

### Sprint 4 (opsional, kalau butuh scale) — Flash-loan arb
- Upgrade size via flashBorrow Kamino (engine `src/kamino.ts` SUDAH ADA — tinggal rakit: borrow → arb → repay dalam satu tx).
- Hanya kalau Sprint 1–2 menunjukkan spread terlalu kecil untuk modal sendiri tapi konsisten.

## 2. Architecture (fit di repo sekarang, zero core changes)

```
src/strategies/arb/
  ├─ venues.ts        # pool layouts verified on-chain (pumpswap, DAMMv2, DLMM, CLMM, Whirlpool)
  ├─ pools.ts         # GPA-diff new-pool feed + vault-truth pricing (JSON-RPC client with backoff)
  ├─ treasure.ts      # ghost filter, mint safety, opportunity math, price formatters
  ├─ quotes.ts        # Jupiter lite quote fetch + normalize (reference prices)
  ├─ spread.ts        # pure math: round-trip bps, profit floor (legacy arb-scan, reusable)
  ├─ types.ts         # mint allowlist + round-trip types (legacy, reusable)
  ├─ scanner.ts       # scanArbPass (spot checks) + scanTreasurePass (live watcher)
  ├─ executor.ts      # tx assembly (compute budget + hops + min-outs), simulate-first — Sprint 2
  └─ inventory.ts     # ledger + P&L + route blacklist — Sprint 3
test/arb.test.ts      # spread math, venue decode, ghost filter, opportunity math, formatters
docs/ARB_TREASURE_RESEARCH.md  # empirical findings that drove the pivot
docs/ARB_ENGINE_PLAN.md  (this file)
```

Reuse yang sudah jalan: `withBackoff` + 429 detection (screener), Telegram alerter (`profit`, `swap`, `execution` builders SUDAH ADA — tinggal wire), simulate-before-broadcast rail, `.env` config pattern, Docker watcher pattern.

## 3. Honest risk list (buat gue sendiri biar nggak self-scam)

| Risk | Mitigasi |
|---|---|
| Spread kebali sama LionX (dia colo di pool yang sama) | LionX BUKAN MEV colo (forensic proof) — ini race RPC-vs-RPC, kita 10s cadence proven. Kalau kalah terus di pair tertentu → blacklist, cari pair sepi |
| Slippage makan margin | min-out per hop + size kecil dulu + profit floor pre-sign |
| Rug pool / token jahat | allowlist mint awal: USDC/USDT/WSOL/JitoSOL/JupSOL/USDS/USDG/PYUSD/EURC saja. No memecoin. |
| Failed tx burn | simulate-first (rail ada); fee 5000 lamports = murah untuk retry |
| Inventory drift (stuck token) | settle-to-USDC policy + alert kalau inventory non-USDC > $X |
| Rate limit Jupiter | @jup-ag/api + backoff (pattern ada); opsional daftar API key gratis |
| Modal kena tebas (bug eksekusi) | wallet khusus $50–200, Nix dry-run 2–3 hari, hard cap tx/day |

## 4. KPI & go/no-go gates

| Gate | Metric | Target |
|---|---|---|
| G1 (Sprint 1 → 2) | spread ≥5bps berulang di top pairs | ≥10 peluang/hari |
| G2 (Sprint 2 dry-run) | simulated net profit | ≥$1/day pada size $100 |
| G3 (Sprint 2 live) | realized net profit ≥ biaya | ≥80% tx profitable |
| G4 (scale up) | konsisten 7 hari | net ≥$3/day → naikin size bertahap |

Target realistis: LionX ngasilin ~$0.10–0.35/tx × ~50–100 tx arb/jam efektif. Kita mulai dari target **$5–10/day net** di 2–3 pasang sepi, grow dari situ. Kalau G1–G2 gagal → kita tidak buang waktu (total biaya riset ≈ $0.01 fee sim + waktu).

## 5. Urutan eksekusi & estimasi effort

| Step | Deliverable | Effort |
|---|---|---|
| A | `docs/ARB_ENGINE_PLAN.md` review + approve | done (this) |
| B | `src/strategies/arb/quotes.ts` + `spread.ts` + tests | ~1 hari |
| C | `arb-scan` CLI + JSONL + run 3 hari | ~½ hari + waktu tunggu data |
| D | Gate G1 decision | data-driven |
| E | `executor.ts` + dry-run mode | ~1–2 hari |
| F | Live kecil ($50) + gate G2/G3 | bertahap |

**Dependency:** ini jalan PARALEL dengan Phase 1 liquidation watcher (bot liquidation tetap jalan kumpul data). Arb engine pakai infra yang sama (RPC, alerter, docker), beda command.
