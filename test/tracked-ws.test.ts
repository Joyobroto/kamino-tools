import { test } from "node:test";
import { strict as assert } from "node:assert";
import { address } from "@solana/kit";
import { subscribeTrackedObligations } from "../src/strategies/liquidation/tracked-ws.js";
const a = address("11111111111111111111111111111111");
const b = address("So11111111111111111111111111111111111111112");
const c = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let n = 0; n < 100 && !check(); n++) await pause(5); assert.ok(check()); }
function stream(signal: AbortSignal) {
  const queue: any[] = []; let wake: (() => void) | undefined; let ended = false;
  const end = () => { ended = true; wake?.(); };
  signal.addEventListener("abort", end, { once: true });
  return { push(value: any) { queue.push(value); wake?.(); }, end,
    async *[Symbol.asyncIterator]() {
      try { while (!ended) { if (queue.length) yield queue.shift(); else await new Promise<void>(resolve => { wake = resolve; }); } }
      finally { signal.removeEventListener("abort", end); }
    },
  };
}
function note(slot: bigint, debt = 100n) {
  const data = Buffer.alloc(3344); data.writeBigUInt64LE(debt, 2208); data.writeBigUInt64LE(80n, 2256);
  return { context: { slot }, value: { data: [data.toString("base64"), "base64"] as const, lamports: 1n } };
}

test("tracked WS diffs account sets, unsubscribes removals and never restarts unchanged streams", async t => {
  const calls: string[] = [], invalidated: string[] = [], delivered: string[] = [];
  const streams = new Map<string, ReturnType<typeof stream>>();
  const handle = subscribeTrackedObligations({ wsUrl: "wss://primary.invalid", startIntervalMs: 1,
    onSlice: slice => delivered.push(slice.pubkey), onInvalidate: key => invalidated.push(key),
    subscribe: async (_, key, signal) => { calls.push(key); const s = stream(signal); streams.set(key, s); return s; },
  });
  t.after(() => handle.abort());
  handle.setAccounts([a, a, b]); await until(() => handle.stats().active === 2);
  handle.setAccounts([a, b]); await pause(); assert.equal(calls.length, 2);
  handle.setAccounts([a, c]); await until(() => handle.stats().active === 2 && calls.length === 3);
  assert.deepEqual(calls, [a, b, c]); assert.ok(invalidated.includes(b)); assert.equal(handle.isSubscribed(b), false);
  streams.get(b)!.push(note(10n)); streams.get(a)!.push(note(10n)); await until(() => delivered.length === 1);
  assert.deepEqual(delivered, [a]);
});
test("tracked WS drops duplicate and older-slot payloads before emitting a signal", async t => {
  let s!: ReturnType<typeof stream>; const slots: bigint[] = [];
  const handle = subscribeTrackedObligations({ wsUrl: "wss://primary.invalid", startIntervalMs: 1,
    onSlice: slice => slots.push(slice.slot!), subscribe: async (_, __, signal) => { s = stream(signal); return s; },
  }); t.after(() => handle.abort()); handle.setAccounts([a]); await handle.ready;
  s.push(note(10n)); s.push(note(9n, 200n)); s.push(note(10n)); s.push(note(11n, 200n));
  await until(() => handle.stats().received === 4);
  assert.deepEqual(slots, [10n, 11n]); assert.equal(handle.stats().duplicates, 2);
  assert.ok(handle.stats().payloadBytes > 0);
});
test("stream failure invalidates cached state and reconnects on fallback", async t => {
  const endpoints: string[] = []; let s!: ReturnType<typeof stream>; const invalidated: string[] = [];
  const handle = subscribeTrackedObligations({ wsUrl: "wss://primary.invalid", wsCandidates: ["wss://fallback.invalid"], startIntervalMs: 1, retryMs: 1,
    onSlice: () => {}, onInvalidate: key => invalidated.push(key),
    subscribe: async (endpoint, _, signal) => { endpoints.push(endpoint); s = stream(signal); return s; },
  }); t.after(() => handle.abort()); handle.setAccounts([a]); await handle.ready;
  s.end(); await until(() => endpoints.length === 2 && handle.isSubscribed(a));
  assert.deepEqual(endpoints, ["wss://primary.invalid", "wss://fallback.invalid"]); assert.ok(invalidated.includes(a));
  await pause(25); assert.equal(endpoints.length, 2, "quiet accounts must not reconnect");
});
test("closed accounts invalidate snapshots and abort stops all subscriptions", async () => {
  let s!: ReturnType<typeof stream>; let invalidations = 0;
  const handle = subscribeTrackedObligations({ wsUrl: "wss://primary.invalid", startIntervalMs: 1,
    onSlice: () => {}, onInvalidate: () => invalidations++, subscribe: async (_, __, signal) => { s = stream(signal); return s; },
  });
  try {
    handle.setAccounts([a]); await handle.ready; s.push({ context: { slot: 10n }, value: { lamports: 0n } });
    await until(() => invalidations === 1); assert.equal(handle.isSubscribed(a), false);
  } finally { handle.abort(); }
  handle.setAccounts([b]); assert.equal(handle.stats().desired, 0);
});
