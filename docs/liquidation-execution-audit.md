# Signal-to-execution follow-up audit

Changes after 877775d:

- CLMM's web3.js RPC now shares the scanner's configured failover transport and
  provider cooldown. A working fallback no longer leaves the only swap engine
  querying a rejected primary.
- Cold lookup tables are fetched in one batched request, with shared in-flight
  reads and validation. The live USDT/USDC diagnostic previously failed on a
  companion-table read; after batching it reached on-chain simulation.
- Scope refresh, reserve/obligation refresh, flash borrow, liquidation, swap and
  flash repayment stay in one transaction. Independent simulation cannot see a
  separate warmup transaction. This also avoids promoting SWQOS-sized tips to
  the Sender Max bundle lane and avoids splitting the transaction on fallback.
- Token-2022 liquidity correctly retains the legacy SPL Token program for Kamino
  cToken collateral accounts.
- Repay sizing respects available flash liquidity, redeemable collateral,
  collateral vault liquidity and the market's liquidation-value cap. Same-mint
  repayments require no swap. Invalid prices/slippage/close factors fail early.
- Planning, blockhash reads, simulation, submission and signature polling are
  bounded. Confirmation retries temporary RPC failures and reports timeout as
  unknown; it does not mistake missing responses for an on-chain failure.
  RPC submission now confirms through the supplied failover RPC instead of
  opening a new primary-only WebSocket connection.
- ALT setup enumerates actual per-reserve Scope refresh accounts, including
  mappings/twaps. CLMM discovery failures are reported as incomplete coverage.
- Sender bundle responses require a result, and bundle size is bounded to 1–5.
  Sender bundle behavior was checked against the provider's documentation:
  https://www.helius.dev/use-case/trading

Validation: TypeScript build and 148 tests passed. A read-only mainnet attempt
on 8hUCm5tX79gWTKFY8L2LiDVf2B7B1pVVExRyhaSTr1GC passed packet construction,
Scope/reserve/obligation refresh and flash borrow; reached Liquidate V2; and
correctly returned ObligationHealthy (6016). Executor timing was 424 ms in that
sample. Nothing was broadcast by the diagnostic. The swap and flash repayment
were not executed because liquidation correctly stopped at the healthy gate.

Limits: a healthy signal cannot be successfully liquidated. CLMM-only still
requires a supported liquid pool; the SOL/bSOL sample had no usable route.
A simulation is not a guarantee of landing or winning against other liquidators.
Provider availability, changing oracle/pool state and transaction account limits
remain relevant. Missing on-chain ALT coverage requires setup, not invented
lookup indexes or a larger packet limit.
