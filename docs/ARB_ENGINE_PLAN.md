# ARB Engine Development Plan — "LionX Versi Kita"

> Status: **Sprint 1 BUILT & LIVE (2026-09-04)** — `arb-scan` scanner running in Docker (`arb-scanner` service) alongside the liquidation watcher. Read-only, zero risk.
> Reference competitor: `LionX7R69tL1EEcpRkJ9jRuwV7bi4jFoKmZZnxiVK6y` — reverse-engineered playbook below.
> Principle: **modal sendiri dulu, flash-loan opsional belakangan.** Kita tiru yang terbukti menghasilkan, bukan yang eksotis.

## Sprint 1 — DELIVERED

- `src/strategies/arb/types.ts` — mint allowlist (USDC/USDT/USDS/FDUSD/USDG/PYUSD/WSOL/JitoSOL/JupSOL, no memecoins), decimals, scan options/events
- `src/strategies/arb/spread.ts` — pure math: round-trip bps, profit units→USD, execution gate (`isActionable` with fixed-cost model), ranking
- `src/strategies/arb/quotes.ts` — Jupiter lite API (`lite-api.jup.ag/swap/v1/quote`; the SDK's default `quote-api.jup.ag` host is DNS-blocked from this server — discovered empirically, plain fetch works), 429-backoff (reuses hardened `isRateLimitError` semantics), SOL price derived from quotes (no oracle dep)
- `src/strategies/arb/scanner.ts` — pair loop (base→intermediate→base), event emission
- CLI: `npm run cli -- arb-scan [--size --min-spread --bases --intermediates --watch --interval --log --json]`
- Docker: `arb-scanner` service (30s passes, floor 3bps, $100 size, logs to `data/arb_opportunities.jsonl`)
- Tests: `test/arb.test.ts` — spread math, mint-consistency validation, actionability gates, end-to-end scanner with mocked fetch (60/60 total suite green)

**First live readings (2026-09-04, calm market):** major pairs (USDC↔WSOL↔USDT↔LSDs) quote 0–0.5bps round-trip at $100–500 size — efficient and below cost, exactly as expected in calm conditions. Spread hunting needs dislocation events; the scanner now watches for them 24/7. Gate G1 stays data-driven.

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

### Sprint 1 — Quote scanner (read-only, zero risk) ← START HERE
**Goal:** bukti ada spread yang bisa diambil, SEBELUM nulis eksekusi.

- Poll Jupiter Quote API v6 (`@jup-ag/api` sudah ada di node_modules, FREE, rate-limit 60 req/s public / lebih kalau daftar) untuk pasangan top-N likuid.
- Compute: `spread_bps = (bestRouteOut/in − 1) × 10_000` untuk route A→B→A (triangular) dan A→B langsung antar-quote-session (temporal arb: quote t0 vs quote t1).
- Filter: spread > 5bps (biaya: fee ix 5000 lamports ≈ 0.005¢ + slippage), likuiditas pool > $10K.
- Output: `npm run cli -- arb-scan` — table + JSONL `arb_opportunities.jsonl` (pair, route, spread, est profit per $X size).
- **Gate:** kalau dalam 3–7 hari scanner nggak nemu spread ≥ 5bps yang berulang → stop, fokus liquidation saja.

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
  ├─ quotes.ts        # Jupiter quote fetch + normalize (pair, route, outAmount, priceImpact)
  ├─ spread.ts        # pure math: spread_bps, triangular detect, min-out calc, profit floor
  ├─ scanner.ts       # poll loop + JSONL logging (arb-scan command)
  ├─ executor.ts      # tx assembly (compute budget + hops + min-outs), simulate-first
  └─ inventory.ts     # ledger + P&L + route blacklist
test/arb.test.ts      # spread math, route validation, min-out gate — all pure
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
