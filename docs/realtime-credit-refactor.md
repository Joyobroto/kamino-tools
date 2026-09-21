# Realtime obligation subscriptions and RPC usage

Previously the bot subscribed to all 3,344-byte obligation account changes in the
market, despite only retaining its small hot cohort. It also fetched every hot
account each ten-second tick and re-primed oracle accounts over HTTP even while
fresh WS data was arriving.

The watcher now:

- Uses exact `accountSubscribe` subscriptions for `HotTracker.hotObligations()`:
  the configured capped watch tier plus all known DUE positions. The former
  market-wide program subscription is removed.
- Diffs subscription sets, retaining unchanged streams and aborting removed ones.
  Additions are paced at ten per second. Subscriptions share pooled clients per
  endpoint; SDK channel pooling and ping keepalive remain enabled.
- Reconnects failed streams with bounded backoff and sticky provider fallback.
  Quiet accounts do not cause periodic reconnects. Disconnects, removals and
  account closures invalidate cached account bytes.
- Rejects out-of-order/duplicate payloads before triggering execution. Duplicate
  filtering saves local work; these bytes have already arrived and may be billed.
- Reuses live subscribed account snapshots for up to 60 seconds, revalued from
  current oracle prices. Missing/expired/disconnected snapshots still receive
  HTTP reconciliation. Execution retains its simulation and transaction guards.
- Uses the oldest required oracle account's HTTP/WS observation to measure
  freshness. Fresh WS feeds no longer force an HTTP prime every ten seconds;
  stale feeds still trigger reconciliation.
- Emits cumulative `[WS-USAGE]` counters each minute: active/desired accounts,
  notifications, base64 account payload MB, duplicates and reconnects. Payload
  volume excludes JSON framing and oracle streams; it is not a billing total.

The broad discovery scan and its configured interval remain in place. A position
outside the tracked cohort enters realtime account coverage when discovery finds
it. This is a coverage/cost tradeoff: unknown positions that become unhealthy
between discovery scans no longer have a market-wide WS trigger. Known tracked
positions retain account-change and oracle-driven signals.

Full-scan hydration remains a separate RPC cost driver. No measured percentage
of credit savings is claimed. Compare the provider's same-duration usage windows
and the new stream counters after deployment.

Helius documents byte-metered WSS traffic, so narrowing the server subscription
scope matters for credits, not just filtering messages after receipt:
https://www.helius.dev/blog/laserstream-websockets

Validation: TypeScript build and 155 tests pass, including differential
subscriptions, disconnect invalidation/fallback, quiet accounts, duplicate/order
filtering, closure cleanup, hot-cache reuse, stale-cache reconciliation and
oracle HTTP-prime suppression while WS observations remain fresh.
