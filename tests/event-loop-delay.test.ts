import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventLoopDelayMonitor } from "../src/observability/event-loop-delay.js";

describe("event loop delay monitor", () => {
  it("exposes non-negative ms metrics and reset clears the next max window", async () => {
    const monitor = new EventLoopDelayMonitor(10);
    monitor.enable();
    try {
      // Warm the histogram so the next delay is against a live sampler.
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Block the event loop without spinning (libuv delay is measured between turns).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 30));

      const first = monitor.snapshot({ reset: true });
      assert.ok(first.max_ms >= 50, `expected max_ms>=50 after block, got ${JSON.stringify(first)}`);
      assert.ok(first.mean_ms >= 0);
      assert.ok(first.p99_ms >= 0);
      assert.equal(first.resolution_ms, 10);

      await new Promise((resolve) => setTimeout(resolve, 40));
      const afterReset = monitor.snapshot({ reset: false });
      assert.ok(
        afterReset.max_ms < 50,
        `quiet window after reset should keep max_ms<50, got ${afterReset.max_ms}`,
      );
    } finally {
      monitor.disable();
    }
  });
});
