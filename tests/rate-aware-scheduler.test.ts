import assert from "node:assert/strict";
import test from "node:test";
import { RateAwareScheduler } from "../src/market/rate-aware-scheduler.js";

test("history scheduler centralizes requests and recovers after a failed task", async () => {
  let clock = 0;
  const starts: number[] = [];
  const scheduler = new RateAwareScheduler(60, () => clock, async (ms) => { clock += ms; });
  const first = scheduler.schedule(async () => { starts.push(clock); return 1; });
  const failed = scheduler.schedule(async () => { starts.push(clock); throw new Error("boom"); });
  const third = scheduler.schedule(async () => { starts.push(clock); return 3; });
  assert.equal(await first, 1);
  await assert.rejects(failed, /boom/);
  assert.equal(await third, 3);
  assert.deepEqual(starts, [0, 1000, 2000]);
  assert.equal(scheduler.status().failed, 1);
  assert.equal(scheduler.status().completed, 2);
});

