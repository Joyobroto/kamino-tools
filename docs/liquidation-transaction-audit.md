# Liquidation transaction audit

The saved ledger (`data/liq_autofire_ledger.jsonl`, 2026-09-18T15:24:59.679Z)
records a 1,407-byte Jupiter transaction and a 1,595-byte KSwap transaction,
with 15 uncovered accounts. Both exceed the 1,232-byte packet limit. Multiple
HTTP routes increased latency without solving missing lookup-table coverage.

Changes:

- Liquidation uses only the existing local Raydium CLMM quoter and instruction
  builder. No Jupiter race or KSwap fallback. Pairs without a usable CLMM pool
  are skipped. CLMM snapshot invalidation and one retry remain.
- Lookup selection preserves complete on-chain table address arrays. Filtering
  arrays renumbered address indexes, producing incorrect account references.
  The 256-account limit applies to the message, not combined stored table sizes.
- Shared cached transaction construction checks serialized packet size,
  including warmup transactions, and reports uncovered addresses. Signing and
  encoding errors retain their original cause.
- Setup considers every reserve pair rather than the first 21. Primary table
  creation uses one slot/address derivation. Companion tables use past slots.
- KSwap module and direct dependency removed; CLMM dependencies declared
  directly. Separate arbitrage commands retain their own Jupiter integration.

Validation is offline: compiled lookup indexes resolve against original table
contents; real signed packets fit with compression and fail without it; the
mocked liquidation executor reaches ready and submits through its Sender lanes.
No mainnet liquidation, setup transaction, or deployment was performed.

Existing on-chain ALTs are not changed by a source edit. Before deploying,
refresh coverage with `npm run cli -- liq-setup --all` (this submits setup
transactions and spends SOL), then restart the bot with the new build. Setup
can be slow across all reserve pairs. Moving tick arrays may require subsequent
extensions. CLMM-only does not guarantee that every obligation fits: instruction
payloads, dynamic accounts, and missing coverage remain bounded by the packet
limit and are rejected before submission.
