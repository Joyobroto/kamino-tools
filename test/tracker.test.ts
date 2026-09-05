import assert from "node:assert/strict";
import { test } from "node:test";
import { HotTracker } from "../src/strategies/liquidation/tracker.js";
import type { LiquidatableCandidate } from "../src/strategies/liquidation/types.js";

function candidate(obligation: string, healthFactor: number, debtUsd = 500): LiquidatableCandidate {
  return {
    obligation,
    tag: 0,
    healthFactor,
    depositedValueUsd: debtUsd * 1.2,
    borrowedValueUsd: debtUsd,
    largestDebt: { reserve: "ResUSDC11111111111111111111111111111111111", symbol: "USDC", amountUsd: debtUsd },
    collateralSymbols: ["USDS"],
    estimatedProfitUsd: debtUsd * 0.01,
  };
}

const T0 = "2026-09-03T21:35:44.000Z";
const T1 = "2026-09-03T21:35:54.000Z"; // +10s
const T2 = "2026-09-03T21:36:04.000Z"; // +20s
const T3 = "2026-09-03T21:36:52.000Z"; // +68s

const TH = { nearMissHealth: 1.05, hotHealth: 1.02, watchHealth: 1.02, maxWatch: 60 };

test("absorb emits spotted for new DUE (<1.0) candidates; near-miss above watch band is ignored", () => {
  const tracker = new HotTracker(TH);
  const events = tracker.absorb([candidate("A", 0.99), candidate("B", 1.03)], T0);
  assert.equal(events.filter((e) => e.type === "spotted").length, 1);
  assert.equal(events.filter((e) => e.type === "watching").length, 0, "1.03 >= watchHealth 1.02 → not watched");
  assert.equal(tracker.size, 1);
  assert.deepEqual(tracker.trackedObligations(), ["A"]);
});

test("absorb admits near-miss candidates below watchHealth into the watch tier (bounded)", () => {
  const tracker = new HotTracker({ ...TH, maxWatch: 2 });
  const events = tracker.absorb([candidate("A", 1.01), candidate("B", 1.015), candidate("C", 1.018)], T0);
  // watch tier = 3 candidates below 1.02, cap 2 → healthiest (C, 1.018) trimmed
  assert.ok(events.filter((e) => e.type === "watching").length >= 2);
  assert.equal(tracker.size, 2);
  const tracked = tracker.trackedObligations();
  assert.ok(tracked.includes("A"));
  assert.ok(tracked.includes("B"));
  assert.ok(!tracked.includes("C"));
});

test("watch tier trim keeps the closest-to-DUE positions under surge", () => {
  const tracker = new HotTracker({ ...TH, maxWatch: 2 });
  tracker.absorb([candidate("A", 1.001), candidate("B", 1.005), candidate("C", 1.019)], T0);
  const tracked = tracker.trackedObligations();
  assert.ok(tracked.includes("A"), "closest to DUE must stay");
  assert.ok(tracked.includes("B"), "second closest must stay");
  assert.ok(!tracked.includes("C"), "healthiest must be trimmed first");
});

test("DUE positions are tracked regardless of the watch cap", () => {
  const tracker = new HotTracker({ ...TH, maxWatch: 1 });
  const events = tracker.absorb([candidate("A", 0.99), candidate("B", 0.98), candidate("C", 0.97)], T0);
  assert.equal(events.filter((e) => e.type === "spotted").length, 3);
  assert.equal(tracker.size, 3);
  assert.equal(tracker.dueObligations().length, 3);
});

test("hot update promotes a watched near-miss to DUE", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 1.004)], T0); // enters watch tier
  assert.equal(tracker.size, 1);
  const events = tracker.applyHotUpdate([candidate("A", 0.998)], T1);
  assert.equal(events.filter((e) => e.type === "promoted").length, 1);
  assert.deepEqual(tracker.dueObligations(), ["A"]);
});

test("missing hot obligation emits taken with wasDue=false when it was only watched", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 1.004)], T0);
  const events = tracker.applyHotUpdate([], T3);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "taken");
  if (events[0]!.type === "taken") {
    assert.equal(events[0]!.obligation, "A");
    assert.equal(events[0]!.satSeconds, 68);
    assert.equal(events[0]!.wasDue, false);
  }
  assert.equal(tracker.size, 0);
});

test("missing DUE obligation emits taken with wasDue=true", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 0.99)], T0);
  const events = tracker.applyHotUpdate([], T3);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "taken");
  if (events[0]!.type === "taken") {
    assert.equal(events[0]!.wasDue, true);
    assert.equal(events[0]!.satSeconds, 68);
    assert.equal(events[0]!.firstSpottedAt, T0);
  }
});

test("obligation healed above near-miss band is released with healed event", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 0.99)], T0);
  const events = tracker.applyHotUpdate([candidate("A", 1.055)], T2);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "healed");
  if (events[0]!.type === "healed") {
    assert.equal(events[0]!.obligation, "A");
    assert.ok(Math.abs(events[0]!.lastHealth - 1.055) < 1e-9);
  }
  assert.equal(tracker.size, 0);
});

test("obligation still inside near-miss band stays tracked without events", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 0.99)], T0);
  const events = tracker.applyHotUpdate([candidate("A", 1.02)], T1);
  assert.equal(events.length, 0);
  assert.equal(tracker.size, 1);
  assert.deepEqual(tracker.dueObligations(), []);
});

test("repeated absorb of the same DUE candidate does not re-emit spotted", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 0.99)], T0);
  const events = tracker.absorb([candidate("A", 0.991)], T1);
  assert.equal(events.length, 0);
});

test("surge: mass crossing floods watch tier and tracker keeps the most endangered", () => {
  const tracker = new HotTracker({ ...TH, maxWatch: 5 });
  const flood = Array.from({ length: 30 }, (_, i) => candidate(`O${i}`, 1.0 + (i / 1000)));
  tracker.absorb(flood, T0); // 30 near-miss candidates, cap 5
  const tracked = tracker.all();
  assert.equal(tracked.length, 5);
  // must be the 5 lowest health of the flood (O0..O4 are lowest)
  for (const entry of tracked) {
    assert.ok(entry.lastSeenHealth <= 1.005);
  }
  // simulate all 5 crossing
  const updates = tracked.map((e) => candidate(e.candidate.obligation, 0.97));
  const events = tracker.applyHotUpdate(updates, T1);
  assert.equal(events.filter((e) => e.type === "promoted").length, 5);
  assert.equal(tracker.dueObligations().length, 5);
  // a second absorb with more near-miss still respects cap for watch tier, but DUE stay
  tracker.absorb(flood.map((c, i) => candidate(`O${i}`, 1.01)), T2);
  assert.equal(tracker.dueObligations().length, 5);
});

test("hysteresis: single tick above watch band is boundary noise, not a taken event", () => {
  const tracker = new HotTracker(TH);
  tracker.absorb([candidate("A", 1.005)], T0); // watch tier
  // bounces above band once
  let events = tracker.applyHotUpdate([candidate("A", 1.025)], T1);
  assert.equal(events.length, 0, "one tick above band must not emit taken");
  assert.equal(tracker.size, 1);
  // back inside band resets the counter
  events = tracker.applyHotUpdate([candidate("A", 1.01)], T2);
  assert.equal(events.length, 0);
  // two consecutive ticks above band releases it
  events = tracker.applyHotUpdate([candidate("A", 1.03), candidate("A", 1.03)], T3);
  const takenEvents = events.filter((e) => e.type === "taken");
  assert.equal(takenEvents.length >= 1, true, "two consecutive above-band ticks must release");
  assert.equal(tracker.trackedObligations().includes("A"), false);
});
