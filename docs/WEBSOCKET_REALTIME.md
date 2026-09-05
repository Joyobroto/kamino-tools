# WebSocket Realtime Monitoring — AccountSubscriptionManager

> Status: **DEFERRED (design doc)** — build only if validation data demands it (see decision gate).

## What it is

The installed Kamino SDK (`@kamino-finance/klend-sdk`) ships a production-grade WebSocket layer:
`ws/AccountSubscriptionManager` (dist/ws/accountSubscriptionManager.d.ts). It subscribes to Solana
`programNotifications` over WSS and pushes account changes the moment they land on-chain —
**~1 slot (~400ms)** after a transaction touches an obligation, versus our current 60s polling cycle.

## Capabilities (from SDK source audit)

| Feature | Detail |
|---|---|
| Push delivery | `programNotifications` on the KLend program; callback per changed account |
| Ref-counted lifecycle | First subscriber starts WS; last unsubscribe tears it down |
| Dedup + ordering | Slot-based ordering, buffer dedup (skips unchanged data) |
| Auto-reconnect | Exponential backoff, per-listener `onReconnect` hook for state refresh after downtime |
| Throttle control | Per-subscriber `throttleMs` (shortest wins across subscribers on same filter key) |
| Program filters | `dataSize` + `memcmp` (base58) — same filter grammar as our GPA snapshot |
| Error isolation | Decode/listener throws are reported, never crash the connection |

## Architecture (when we build it)

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│ Phase A: GPA snapshot   │ ──▶ │ In-memory obligation cache   │
│ (existing scanner, once │     │ (105K obligations + health  │
│  per boot / reconnect) │     │  + ADL fields)               │
└─────────────────────────┘     └──────────────┬───────────────┘
                                                │ delta updates (~400ms)
┌──────────────────────────────┐                ▼
│ WS programNotification       │ ──▶ patch cache → re-run funnel
│ filter: KLend program +      │     (health < 1.0? ADL byte set?)
│ dataSize 3344 + memcmp market│     → emit spotted/taken events
└──────────────────────────────┘     → same JSONL as polling mode
```

Key points:

- WS streams are **deltas only** — the GPA snapshot (our two-phase phase A) remains the
  source of initial state. WS keeps it fresh.
- Subscribe at **program level with memcmp filters**, not per-account: one connection covers
  all 105K obligations; notifications arrive only for accounts that actually changed.
- The same funnel code (`filters.ts`) is reused — WS only changes the transport, not the logic.

## Usage sketch (SDK)

```ts
import { createSolanaRpcSubscriptions } from "@solana/kit";
import { AccountSubscriptionManager } from "@kamino-finance/klend-sdk";

const wsRpc = createSolanaRpcSubscriptions("wss://mainnet.helius-rpc.com/?api-key=KEY");
const manager = new AccountSubscriptionManager({
  wsRpc,
  onError: (e) => console.error("ws", e),
  reconnectDelayMs: 5_000,
});

const handle = await manager.subscribeProgramAccounts(
  KLEND_PROGRAM_ID,
  {
    filters: [
      { dataSize: 3344n },
      { memcmp: { offset: 32n, bytes: MAIN_MARKET, encoding: "base58" } },
    ],
    throttleMs: 1_000,          // batch bursts into 1s cadence
    onReconnect: () => rescanAll(), // refresh full state after WS downtime
  },
  (address, buffer, slot) => {
    // buffer = raw account bytes → reuse parseObligationSlice-style decoding
    // (3344-byte full account here, not the 130-byte GPA slice)
  },
);
```

## Decision gate — when to build this

The validation-week `satSeconds` data decides:

| Median satSeconds of DUE positions | Verdict |
|---|---|
| > 60s | **Polling 60s is sufficient.** WS stays deferred — positions sit long enough that 400ms vs 60s changes nothing. |
| 15–60s | Gray zone — consider WS for Phase 2/3, paired with faster hydration of hit candidates. |
| < 15s | **WS becomes mandatory** for Phase 2/3 — polling loses nearly every race. |

## Operational caveats

1. **Helius WSS limits** — verify our plan's concurrent WS connection + notification throughput
   tiers before adopting. Program-level subscription = 1 connection (cheap), but notification
   volume follows market activity.
2. **Reconnect gaps** — state can drift during WS downtime. Always re-snapshot via GPA on
   `onReconnect` (pattern is built into the SDK hook).
3. **Cost of being early** — WS doesn't create opportunity; it only reduces detection latency.
   If tail positions truly sit for minutes (thesis), the 60s poll already sees 99% of them.
