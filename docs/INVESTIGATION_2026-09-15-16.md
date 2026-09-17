# Kamino liquidation investigation: September 15–16, 2026

Scope: September 15–16 in UTC+7 (Asia/Bangkok/WIB). Read-only investigation of execution; no bot code changed, transactions sent, or services restarted. Existing uncommitted changes were preserved.

## Evidence and counts

- Docker log retained for the current container: September 15 05:59:47 UTC through September 16 00:55:58 UTC (12:59:47 through 07:55:58 UTC+7), 21,681 lines. This is not two complete days of logs.
- Container stopped September 16 00:57:21 UTC / 07:57:21 UTC+7, exit 137, `OOMKilled=false`. Cause of termination is not established. Its healthcheck unconditionally exits zero and does not measure scanner/executor health.
- Persisted liquidation ledger: 109 skipped execution attempts across 82 obligations, zero fired records; 105 additional veto records, of which 98 describe the same healthy simulation attempts and seven are hydration failures. Do not count these as 214 attempts.
- Local-date attempts: September 15 = 38; September 16 = 71. All selected ledger timestamps are September 15 UTC because the final attempt was at 18:50 UTC / September 16 01:50 UTC+7.

| Attempt result | Count |
| --- | ---: |
| Kamino ObligationHealthy (6016) | 98 |
| Raydium InvalidFirstTickArrayAccount (6024) | 5 |
| Raydium MissingTickArrayBitmapExtensionAccount (6035) | 2 |
| Transaction exceeds 1232 bytes | 3 |
| All swap routes unquotable | 1 |

Attempt latency recorded in the ledger: median 652 ms, p95 3,906 ms, maximum 5,345 ms. Seven CLMM failures took 165–274 ms, showing that fast assembly alone does not produce a valid transaction.

## P0: CLMM cache never actually refreshes

`src/strategies/liquidation/clmm.ts:143–161` retains the settled hydration promise in `cached.state`. Once the 60-second state TTL expires, the next branch simply returns that original promise. `keepWarm()` follows the same path. Expired negative-cache entries and transient failures are also retained indefinitely.

Reproduced without network access by substituting the hydration method: repeated reads and keepWarm of an expired positive entry caused only one discovery; an expired negative entry also caused only one discovery instead of two. The deployed container's CLMM file and workspace file have identical SHA-256 (`7a2026ef02fced5d5519d5f2f0240bdd947b3d29a29297db13d629b30ecfa72b`).

The five 6024 logs show mismatched first tick arrays, including -22980 versus -23100/-23160/-23280, and -23100 versus -23460. Frozen pool state is a strong causal explanation; exact historical pool-cache payloads were not retained.

Proposed fix: separate `inFlight` from completed snapshots, clear in-flight state on completion/failure, expire negative results, and retry transient reads. Separate slow pool discovery from fast pool/tick/bitmap updates. Subscribe to active pool state or refresh on a tightly bounded cadence; reject stale quotes. Bind each quote and swap instruction to the same snapshot, pool, direction, amount and slot. A working 60-second TTL alone remains too slow for moving CLMM ticks.

## P0: Missing bitmap and incorrect swap argument semantics

`clmm.ts` fetches/decodes the bitmap extension but does not retain/pass its address. `buildSwapInstruction()` passes `undefined` as the final SDK argument; `clmmAltKeys()` also omits the extension despite its comment.

Both 6035 simulations explicitly name Raydium `MissingTickArrayBitmapExtensionAccount`; they are NOT Kamino's unrelated error 6035. All seven CLMM failures contain successful Kamino liquidation logs before the Raydium failure. The entire transaction nevertheless fails; these are not completed liquidations or proven profitable opportunities.

Examples (UTC+7):

| Time | Obligation prefix | Failure |
| --- | --- | --- |
| Sep 15 21:35:24 | 7kzV4xUb | Missing bitmap |
| Sep 15 21:35:25 | DHLQCV1g | Wrong first tick array |
| Sep 15 21:40:21 | 3KbNgiqQ | Wrong first tick array |
| Sep 15 21:51:44 | DkHt1xSc | Missing bitmap |
| Sep 16 01:41:37 | 7aNQVrrD | Wrong first tick array |
| Sep 16 01:45:21 | G5pNBone | Wrong first tick array |
| Sep 16 01:50:02 | H8is58Vt | Wrong first tick array |

Additional source-confirmed defects, not separately observed as named failures in this window:

- The SDK boolean argument is `isBaseInput`, but the caller passes `inputIsA`. Exact-input quotes require `true` in both directions; token-B input currently selects exact-output semantics.
- Cached vaults are already oriented to the initial request, while the builder treats them as canonical A/B vaults. The unordered cache key permits opposite-direction reuse. Store canonical `vaultA/vaultB` and resolve by actual tokenIn on every build.

Proposed fix: retain/validate the bitmap PDA, supply it to the instruction and ALT planner; fix exact-input semantics and canonical vault mapping. Test both mint directions and a pool requiring extended bitmap traversal. Installed SDK source: `node_modules/@raydium-io/raydium-sdk-v2/src/raydium/clmm/instrument.ts:1628`. Official swap implementation for corroboration: https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/instructions/swap.rs (current upstream is not asserted to be identical to deployed bytecode).

## P0: Recover from a bad route within the same attempt

`execute.ts` tries other routes when packet assembly is oversized, but returns immediately on simulation error. A fast invalid local quote therefore wins route selection and prevents an otherwise usable Jupiter/KSwap route from being simulated.

Proposed fix: identify errors by failing program plus code; invalidate/requote the affected CLMM pool once, then try a ready alternative within a strict total deadline. Rebuild, remeasure size, simulate and run profit guards on every candidate. Do not treat a transient route error as an obligation defect: the current generic failure streak can permanently blocklist the obligation after three failures. No such blocklist event was found in this date window.

## P1: Much of the trigger stream arrives after competitor liquidation

Of 98 healthy-simulation vetoes, stored forensics identifies 58 successful competing liquidation signatures and leaves 40 unknown. The resolver checks successful transaction metadata and the target obligation in a KLend liquidation instruction, including inner instructions; five focused error/forensics tests passed during this audit. Historical signatures were not independently re-fetched in this investigation.

All 58 recorded liquidation slots equal the corresponding WS trigger slot. Stored block-time deltas are -676 to -2,112 ms, but block times have second precision: do not interpret these as exact network latency. The same-slot matches strongly suggest notifications caused by already-executed liquidations rather than early actionable warning. Winners in stored evidence: `6mkydi8V…` 32, `2CZ86epN…` 12, `7dGrdJRY…` 9, others 5.

The WS callback uses `slice.cachedHealth` to trigger execution; refreshed simulation then rejects it. Oracle subscriptions already exist and log three feeds live, so simply adding an oracle subscription is not a sufficient proposal.

Proposed fix: trace oracle receive slot/time → fresh reserve/obligation valuation → DUE emission → simulation slot → send. Revalue tracked positions from coherent fresh inputs, and trigger from oracle-driven health changes before obligation account mutations. Make oracle-triggered attempts a distinct ledger rail (currently they flow through hot), record snapshot ages, and distinguish post-liquidation notifications from still-actionable positions. Compare confirmed versus processed subscriptions experimentally with simulation retained. Use the 40 unknown cases as unknown, not assumed losses or recoveries.

## P1: Packet fit and route diagnostics

Three attempts failed before simulation:

- CRFQV43x: Jupiter 1438 bytes; KSwap/OKX 1354.
- HX1SHS8F: KSwap/OKX 1300 bytes.
- 7KKePHCZ: Jupiter-direct 1233 bytes (one byte over); Jupiter 1565; KSwap/OKX 1488.

These report resolved LUTs, unlike the earlier September 14 lookup-table fetch outage. Proposed fix: record uncovered account keys by route, extend the persistent ALT for active route/bitmap/tick accounts where appropriate, prefer constrained/direct routes, and preflight serialized sizes. Do not remove necessary refreshes or min-output checks to fit. The one-byte-over case should be recoverable by account compression if eligible keys are uncovered, but that requires inspecting its exact transaction.

One all-routes-unquotable attempt (EgnDpUcK) spent 2367 ms waiting for quotes. Preserve each backend's error/status, amount, pair, timeout and snapshot age instead of collapsing all causes to null. Separate permanent no-route results from provider failure; the current ten-minute obligation cooldown is excessive for a transient provider outage.

## P2: Subscription and runtime visibility

Four retained `8190003` events mean WebSocket connection closed (two obligation, two oracle). Obligation reconnects are logged. Oracle `onReady` only fires once, so absence of a later ready log does not prove the oracle rail remained disconnected. Emit reconnect and last-update metrics per feed, reject out-of-order slots and re-prime after gaps. Use a per-connection abort controller so failed subscription groups are cleaned up before retrying.

Replace the always-successful container healthcheck with scanner/oracle/executor heartbeat checks and alert on termination. Exit 137 with OOM=false alone cannot distinguish manual kill, stop timeout or other SIGKILL causes.

## Proposed acceptance checks

1. Regression coverage for cache expiry, expired no-pool results, failure recovery and concurrent hydration deduplication.
2. Builder tests for both token directions, exact-input flag, bitmap inclusion and snapshot consistency.
3. Executor test where local CLMM simulation fails but an alternative valid route succeeds; all candidates retain packet/profit/simulation guards.
4. Replay captured failures where fixtures permit; mainnet simulation must reach successful swap and flash repayment. Historical healthy-only simulation is insufficient evidence.
5. Measure oracle-to-trigger latency and classify post-liquidation notifications by slots; retain bounded retry and cost accounting.

No full historical account snapshots are available in the ledger, so the exact profit that could have been captured cannot be calculated from these logs alone.
