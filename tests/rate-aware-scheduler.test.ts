import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECTX_HISTORY_BUDGET,
  PROJECTX_HISTORY_MIN_HEADROOM,
  RateAwareScheduler,
} from "../src/market/rate-aware-scheduler.js";

const TIMEFRAMES_PER_INSTRUMENT = 4;

test("history scheduler recovers after a failed task", async () => {
  let clock = 0;
  const starts: number[] = [];
  const scheduler = new RateAwareScheduler(60, () => clock, async (ms) => { clock += ms; });
  const first = scheduler.schedule(async () => { starts.push(clock); return 1; });
  const failed = scheduler.schedule(async () => { starts.push(clock); throw new Error("boom"); });
  const third = scheduler.schedule(async () => { starts.push(clock); return 3; });
  assert.equal(await first, 1);
  await assert.rejects(failed, /boom/);
  assert.equal(await third, 3);
  assert.deepEqual(starts, [0, 0, 0]);
  assert.equal(scheduler.status().failed, 1);
  assert.equal(scheduler.status().completed, 2);
});

test("parallel schedules consume tokens concurrently inside the provider window", async () => {
  let clock = 0;
  const starts: number[] = [];
  const scheduler = new RateAwareScheduler(60, () => clock, async (ms) => { clock += ms; });
  await Promise.all(Array.from({ length: 12 }, () => scheduler.schedule(async () => {
    starts.push(clock);
  })));
  assert.equal(starts.length, 12);
  assert.ok(starts.every((value) => value === 0));
  assert.equal(scheduler.status().observed_peak_per_window, 12);
  assert.equal(scheduler.status().headroom_per_window, 38);
});

test("canSchedule respects the configured headroom floor", () => {
  let clock = 0;
  const scheduler = new RateAwareScheduler(60, () => clock, async (ms) => { clock += ms; });
  assert.ok(scheduler.canSchedule(12, PROJECTX_HISTORY_MIN_HEADROOM));
  assert.ok(!scheduler.canSchedule(31, PROJECTX_HISTORY_MIN_HEADROOM));
  assert.ok(scheduler.canSchedule(50, 0));
});

// TS-MULTI-02 acceptance: measured headroom instead of an assumed-safe configuration.
for (const instrumentCount of [4, 5, 6]) {
  test(`warming ${instrumentCount} instruments stays inside the ProjectX history budget`, async () => {
    let clock = 0;
    const scheduler = new RateAwareScheduler(60, () => clock, async (ms) => { clock += ms; });
    const requestsPerCycle = instrumentCount * TIMEFRAMES_PER_INSTRUMENT;
    const cycles = 4;

    for (let cycle = 0; cycle < cycles; cycle += 1) {
      await Promise.all(
        Array.from({ length: requestsPerCycle }, () => scheduler.schedule(async () => undefined)),
      );
    }

    const status = scheduler.status();
    assert.equal(status.completed, requestsPerCycle * cycles);
    assert.equal(status.window_ms, PROJECTX_HISTORY_BUDGET.windowMs);
    assert.ok(
      status.observed_peak_per_window <= PROJECTX_HISTORY_BUDGET.requests,
      `peak ${status.observed_peak_per_window} exceeded ${PROJECTX_HISTORY_BUDGET.requests} history requests per window`,
    );
    assert.ok(
      status.headroom_per_window >= 20,
      `headroom ${status.headroom_per_window} left too little room under the provider budget`,
    );
  });
}

test("headroom collapses to zero only when the provider budget is actually consumed", async () => {
  let clock = 0;
  const scheduler = new RateAwareScheduler(60, () => clock, async (ms) => { clock += ms; });
  assert.equal(scheduler.status().observed_peak_per_window, 0);
  assert.equal(scheduler.status().headroom_per_window, PROJECTX_HISTORY_BUDGET.requests);
  await Promise.all(
    Array.from({ length: 50 }, () => scheduler.schedule(async () => undefined, { minHeadroom: 0 })),
  );
  assert.equal(scheduler.status().observed_peak_per_window, 50);
  assert.equal(scheduler.status().headroom_per_window, 0);
});
