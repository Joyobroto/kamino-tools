# ARB Treasure Research — Empirical Findings (2026-09-05)

> Status: **RESEARCH COMPLETE → SCREENER V2 BUILT.** This doc records what we verified on-chain
> before building. Source playbook: Uyar121's Solana Arbitrage article (4 opportunity types) +
> our own forensic of his example txs (ANB).

## What we set out to verify

The article claims 4 arb playbooks on Solana. We tested each against live mainnet data:

| # | Playbook | Verdict | Evidence |
|---|---|---|---|
| 1 | Hidden treasure (stale mispriced pools) | ⚠️ REAL but 99% graves | ANB token: Gecko showed pools at $0.0096 vs $0.000018 (530x "spread", $6.1M "liquidity"). On-chain vault read: pool holds $28 USDC + 602M ANB (one-sided grave). ALL spread was ghost liquidity + stale cached prices. |
| 2 | New-liquidity mispricing (wrong-ratio pool) | ✅ REAL — the viable one | ~200 new pumpswap pools/hour; migration txs confirmed (createIdempotent+syncNative pattern). The ANB $696K tx from the article = THIS, executed by orderflow bots in the minutes window. |
| 3 | Buy & unstake (LST depeg) | 🟡 deferred (separate track) | JitoSOL/JupSOL watchable via existing pairs scanner; Sanctum instant-unstake research still TODO. |
| 4 | Buy & remove LP (LP-token re-pairing) | 🟡 rare; cheap to bolt on later | Event is uncommon; math (CPMM intrinsic value) easy; needs LP-token pool inventory. |

## Forensic: the article's ANB example txs (both "profit" txs)

- Tx 1 (J8TY8Vkj…): fee payer `ESuvjvsQ…` + counterparty `HLnpSz9h…` (the SAME recurring
  counterparty from our LionX forensic — 9/20 LionX txs). Programs: Phoenix (`cpamdpZ…`) + Meteora
  router. 1.25M CU, fee 5000 lamports. Net: +$696K USDC moved from `6CnzQU…` to the arb wallet.
- Tx 2 (3GRCRJmV…, same second): second bot (+$196K) via a DIFFERENT custom router + Jito tip.
- Structure: user sells ANB into one venue, bot routes the fill through another venue's liquidity,
  captures the mispricing gap — **orderflow insertion / backrun**, exactly LionX's core game.
- **Implication:** the big paydays on playbook #2 are won by operators with custom routers + bundle
  submission. Our edge is the LONG TAIL of these events: the mispricings too small/illiquid for them.

## Key empirical lessons (each cost us real probing)

1. **Aggregator cached prices are worthless for arb.** Gecko's price for ANB was 200,000x off from
   the pool's live vault ratio. Any screener must price from **on-chain vault balances**, never cache.
2. **Name-based grouping is poisoned.** "CUPCAKE" = 5 different mints; "ELUN" = name-collision spam
   on pump-fun (pumpswap ELUN is a completely different coin). Group by **exact mint address** only.
3. **Bonding-curve remnants fake spreads.** WOFI showed "$0.0054 pumpswap vs $0.000011 pump-fun
   (490x!)". The pump-fun entry is the dead curve leftover after migration — liq $0, not tradable.
   Filter: pump-fun venue rows with ~$2.3K liq are curve remnants.
4. **Gecko serves the same pool twice with different staleness** (孙小圣 "3.3% spread" was one pool
   listed twice). Dedupe by pool address.
5. **Jupiter is NOT blind.** We live-tested quotes on fresh pumpswap pools, dust DAMMv2 pools —
   Jupiter routed all of them fine (labels "Pump.fun Amm", "Meteora DAMM v2"). The article's
   "Jupiter can't see jomplang pools" claim doesn't hold for these venues. The real edge is
   **detection latency + vault-truth pricing**, not Jupiter blindness.
6. **Ghost liquidity is everywhere.** Of the newest 200 pools: 0 had 24h volume at scan time,
   21/200 had ≥$5K liquidity, and the "$240K ANB pool" actually held $8.51. Two-sided vault
   verification is mandatory before any opportunity is reported.
7. **Pool program IDs calibrated on-chain** (via known pools, Gecko labels; see item 8 for the
   re-verified layout table — offsets live in `src/strategies/arb/venues.ts`):
   - Pumpswap: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (pool space 301)
   - Meteora DAMMv2 (Gecko label) = `cpamdpZCGK…` (pool space 1112)
   - Meteora DAMM (Gecko "meteora" label) = `LBUZKhRxP…` (space 904)
   - Meteora 944B program `Eo7WjKq…` — mints readable, vaults PDA-derived (excluded)
   - Raydium AMMv4: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (space 752; vaults PDA-derived)
   - Raydium CLMM: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` (pool space 1544)
   - Raydium CPMM: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` (pool space 637; layout unresolved)
   - Orca Whirlpool: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` (space 653)
8. **Feed volume measured:** pumpswap program does ~20,000 tx/min (signature polling NOT viable).
   But **new-pool accounts appear at only ~5 per 90s (~200/hour)** → GPA dataSize-diff polling
   is cheap and sufficient. Cost per new pool: ~10 RPC calls (account + 2 vaults + cross-venue check)
   → ~2K calls/hour. Fine on Helius.
   **Helius RPC update (2026-09-05 evening):** plain `getProgramAccounts` now returns
   *"account index service overloaded"* for large programs — Helius requires
   **`getProgramAccountsV2`** (cursor pagination, 1–10K accounts/page; end-of-pagination is when a
   page returns NO accounts, `paginationKey` may stay non-null). Listing costs measured with V2:
   pumpswap 126K pools=78s · meteora-damm-v2 (cpamdpZ) **1.45M pools=83s** · meteora-damm 156K=10s ·
   CLMM 190K=11s · Whirlpool 156K=2s. Because of this:
   - The feed uses V2 pagination for all listings.
   - `changedSinceSlot` was tested and REJECTED (returns inconsistent page sizes, flaky).
   - Heavy venue (meteora-damm-v2, 1.45M accounts) is diffed only every 8th pass (PoolFeed
     `heavyEvery`) — its launchpad-style listings sit for minutes, so the deferral is free.
   - Full-cycle cadence ~120s for the light venues; recommend `--interval 120` in watch mode.
   Venue identity corrections from the same session (empirically re-verified):
   - Gecko's "meteora-damm-v2" label = program `cpamdpZCGK…` (1112B pools; mints @168/200,
     vaults @232/264 — verified on an ANB pool with live balances).
   - Gecko's "meteora" label = program `LBUZKhRxP…` (904B; mints @88/120, vaults @152/184 —
     verified on SOL/USDC with 23.9K SOL / 2.6M USDC).
   - Program `Eo7WjKq6…` (944B, 16K pools) has mints @8/40 but **PDA-derived vaults** (not at
     fixed offsets) — excluded from v1 watch set.
   - Raydium AMMv4 vaults are likewise PDA-derived; CPMM 637B layout unresolved — both excluded.
9. **Raydium public API is down/429-blocked** from this server (api.raydium.io/v2/main/pairs → 500/429).
   GeckoTerminal free tier is reachable (30 calls/min, only sort desc allowed, 429s need 3s+ pacing).
   → Design must be **RPC-native first**, aggregator APIs optional enrichment only.
10. **Token Program ID trap** (wasted an hour): correct is `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
    (ends Q5DA). A 33-byte lookalike (`…QXDAP`) passes string compare but fails address decode.
    Also: raw-fetch JSON-RPC `getTokenAccountsByOwner` breaks on Helius ("WrongSize"); use GPA with
    memcmp owner filter on the Token program instead (offset 32, dataSize 165) — proven working.

## The strategy this research supports

**"Treasure Watcher" (Screener v2)** — read-only, zero risk, same pattern as our liquidation watcher:

1. **GPA-diff pool feed** per venue (pumpswap, DAMMv2, DLMM, Raydium AMMv4/CLMM/CPMM, Orca) —
   detect new pools within ~60s of creation.
2. **Decode on creation**: mints, vaults, decimals → **price from vault ratio** (truth, not cache).
3. **Ghost-liquidity filter**: both vaults must hold real value (threshold configurable, default $1K/side).
4. **Cross-venue check**: same mint on other venues (Jupiter quote + our own pool inventory) →
   spread > threshold (default 5%) → **Telegram alert** with pool, mints, ratio, sizes.
5. **Honeypot guard**: mint authority renounced, freeze authority null, transfer fee 0 — all checked
   before alerting (article's manual "check Solscan" step, automated).
6. **JSONL event log** (`data/treasure_events.jsonl`) for backtest: how often, how big, how long
   the mispricing persists (our own validation-week data).

Sprint 2 (executor) stays gated on 1-2 weeks of watcher data, exactly like the liquidation track.
The atomic edge remains: flash-loan WSOL/USDC → buy cheap venue → sell rich venue → repay, one tx,
zero leg risk, $0.0007 retry cost — vs manual players who carry inventory + two-leg risk.

## Honest risk list (updated for this play)

| Risk | Mitigation |
|---|---|
| New-pool mispricing window is minutes (MEV race) | We race the LONG TAIL: pools <$50K where Jito-bribe economics don't work for the big bots. Alert-fast is enough; atomic tx means we never chase. |
| Rug token / honeypot (can buy, can't sell) | vault-truth both sides + mint authority/freeze/transfer-fee checks pre-alert; allowlist mode for auto-execution later |
| Sniper competition on fresh pumpswap migrations | Migrations are price-continuous (no spread); we watch for WRONG-RATIO pools (the "0.006 Jesus + 0.2 SOL" case), which are less contested |
| False positives from data noise | every alert re-verifies on-chain at alert time; JSONL keeps raw evidence for backtest |
| RPC load | measured: ~2K calls/hour worst case — fine |

## Files

- `research/` — all probe scripts used for this doc (kept for reproducibility; not part of the app)
- `src/strategies/arb/venues.ts` — venue registry (program IDs, layouts, decoders) ← the hard-won constants
- `src/strategies/arb/pools.ts` — GPA-diff new-pool feed + vault-truth pricing
- `src/strategies/arb/treasure.ts` — ghost filter, cross-venue compare, honeypot guard, events
- `src/strategies/arb/scanner.ts` — `treasure-scan` command (one-shot + watch mode)
- `test/arb.test.ts` — extended with venue decode + pricing + ghost-filter tests

## Cross-Venue Arb Verdict (2026-09-07) — CONSTANT-PRODUCT VAULT-RATIO EDGE

After the Jupiter-triangle experiment returned always-negative (data/triangle_probe*.jsonl:
3/67 positive @ $200, all < $0.11; 0/36 @ $2000 — bigger size = 6x more drag), we built a
cross-venue vault-truth arb engine (src/strategies/arb/crossvenue*.ts, `cv probe/scan/verify`).

### Premise: same (token, quote) in two constant-product venues → vault-ratio dislocation.

Built:
- `crossvenue.ts` — vault mid-price, pool orientation, venue subset
- `crossvenue-plan.ts` — full AMM swap-math planner (constant-product + fee), P&L, best-size sweep
- `crossvenue-scan.ts` — index + scan across constant-product venues
- `cv-probe` / `cv-scan` / `cv-verify` CLI commands
- 85/85 unit tests pass (planner math, orientation, guards, direction flip)

### Empirical venue verdicts (live mainnet, 588K→156K pools scanned)

| Venue | SOL/USDC pools | Vault ratio | Market executable | Verdict |
|---|---|---|---|---|
| pumpswap | 10 (all shallow, max 1.11 SOL) | $77–106 | ~$105-107 | constant-product OK, but TOO SHALLOW for cross-venue |
| meteora-damm-v1 (LBUZKh) | 94 deep | **$170-474** (5 pools $200-380) | **$106.78** | ❌ **PHANTOM** — vault ratio is NOT executable |
| meteora-damm-v2 | (scan too slow, rate-limited) | — | — | pending, suspect same as v1 |
| raydium-clmm / orca-whirlpool | excluded | CLMM fantasy | — | excluded (proven non-executable ratio) |

### Finding
- **Only pumpswap is a proven executable-by-vault-ratio constant-product venue**, and its
  SOL/USDC cross-venue depth is trivial (largest pool 1.11 SOL) — **no executable SOL/USDC pair**.
- **meteora-damm-v1 vault ratios read $200-380 while the market executes at $106.78** (verified via
  Jupiter `onlyDirectRoutes=true` → $106.78). Its 904B layout was only ever validated on ONE pool;
  the vault-field offsets are wrong/stale for the bulk of pools → every damm-v1 ratio is untrustable.
- **Net: cross-venue SOL/USDC constant-product arb has no executable edge.** The vault-ratio
  approach is validated on pumpswap but that venue alone can't host a cross-venue pair.
- Consequence: the viable DEX-arb tracks remain **treasure** (new-pool mispricing, depth-gated) and
  **LST depeg** (market-vs-oracle), both of which already run in Docker (shadow mode).

### Design constraint lock-in (for anyone reviving this)
Always gate any vault-ratio claim on the ORIGINAL observation: vaultA must hold pool.mintA and
vaultB must hold pool.mintB (decoded from the vault's own token account) BEFORE trusting a ratio.
damm-v1 mainly fails this/markets at phantom prices → discard. Only use Jupiter `onlyDirectRoutes`
as the executable cross-check, never the multi-hop router (it eats the spread).
