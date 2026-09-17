import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTaskQueue, firstUsable, withDeadline } from "../src/strategies/liquidation/pipeline.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("first usable route does not wait for slow Jupiter or a failed backend", async () => {
  const never = new Promise<string | null>(() => {});
  assert.equal(await firstUsable([never, Promise.resolve(null), Promise.resolve("local")]), "local");
  assert.equal(await firstUsable([Promise.resolve(null), Promise.reject(new Error("down"))]), null);
  assert.equal(await withDeadline(never, 5), null);
});

test("queue reserves exactly three slots during a synchronous burst and drains failures", async () => {
  let active = 0, peak = 0, completed = 0;
  const errors: unknown[] = [], release: Array<() => void> = [];
  const enqueue = createTaskQueue(3, (error) => { errors.push(error); });
  for (let i = 0; i < 9; i++) enqueue(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => release.push(resolve));
    active--; completed++;
    if (i === 1) throw new Error("expected failure");
  });
  await tick();
  assert.equal(active, 3);
  for (let batch = 0; batch < 3; batch++) {
    release.splice(0).forEach((done) => done());
    await tick();
  }
  assert.equal(completed, 9); assert.equal(peak, 3); assert.equal(errors.length, 1);
  enqueue(() => { throw new Error("sync failure"); });
  enqueue(async () => { completed++; });
  await tick();
  assert.equal(completed, 10); assert.equal(errors.length, 2);
});

test("queue prioritizes fresh race work while preserving FIFO ties", async () => {
  const started: number[] = [];
  const release: Array<() => void> = [];
  const enqueue = createTaskQueue(1, () => {});
  enqueue(async () => { started.push(1); await new Promise<void>((resolve) => release.push(resolve)); });
  enqueue(async () => { started.push(2); });
  enqueue(async () => { started.push(3); }, 10);
  await tick();
  assert.deepEqual(started, [1]);
  release.shift()!();
  await tick();
  assert.equal(started[1], 3);
});

import { validateRoutes } from "../src/strategies/liquidation/pipeline.js";
test("bad CLMM simulation falls back to a valid route without waiting for a hung provider", async () => {
  const seen: string[] = [];
  const value = await validateRoutes({first:"clmm", alternatives:()=>[new Promise(()=>{}),Promise.resolve("oversized"),Promise.resolve("jupiter")],budgetMs:100,
    validate:async(route)=>{seen.push(route); return route === "jupiter" ? {value:{tx:"validated",profit:1}} : {};}});
  assert.deepEqual(seen,["clmm","oversized","jupiter"]); assert.equal(value?.tx,"validated");
});
test("terminal healthy veto stops alternative attempts and deadline rejects late validation", async () => {
  let fetched = false;
  assert.equal(await validateRoutes({first:1,alternatives:()=>{fetched=true;return [Promise.resolve(2)];},budgetMs:50,validate:async()=>({terminal:true})}),null);
  assert.equal(fetched,false);
  assert.equal(await validateRoutes({first:1,alternatives:()=>[],budgetMs:5,validate:async()=>{await new Promise(r=>setTimeout(r,20));return {value:"too late"};}}),null);
});
