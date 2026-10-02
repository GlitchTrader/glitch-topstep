import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplyLagTracker } from "../src/observability/apply-lag.js";

describe("apply lag tracker", () => {
  it("keeps max on a single spike and p99 on the body, then reset clears the window", () => {
    const tracker = new ApplyLagTracker();
    for (let index = 0; index < 100; index += 1) {
      tracker.observe("quote", 1_000);
    }
    tracker.observe("quote", 180_000);

    const window = tracker.snapshot({ reset: false });
    assert.equal(window.quote.count, 101);
    assert.equal(window.quote.min_ms, 1_000);
    assert.equal(window.quote.max_ms, 180_000);
    assert.equal(window.quote.last_ms, 180_000);
    assert.equal(window.quote.p99_ms, 1_000);
    assert.equal(window.identity.count, 0);

    const reset = tracker.snapshot({ reset: true });
    assert.equal(reset.quote.max_ms, 180_000);
    const next = tracker.snapshot({ reset: false });
    assert.deepEqual(next.quote, {
      min_ms: 0,
      max_ms: 0,
      p99_ms: 0,
      last_ms: 0,
      count: 0,
    });
  });
});