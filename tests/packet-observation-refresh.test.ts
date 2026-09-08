import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedPacketObservationRefresh } from "../src/service/packet-observation-refresh.js";

describe("boundedPacketObservationRefresh", () => {
  it("skips refresh when observation is already fresh", async () => {
    let calls = 0;
    const result = await boundedPacketObservationRefresh({
      budgetMs: 1_000,
      observationFresh: true,
      refresh: async () => {
        calls += 1;
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped_fresh, true);
    assert.equal(result.timed_out, false);
  });

  it("returns within budget when refresh hangs", async () => {
    let resolveHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    const started = Date.now();
    const result = await boundedPacketObservationRefresh({
      budgetMs: 50,
      observationFresh: false,
      refresh: () => hang,
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.skipped_fresh, false);
    assert.ok(result.waited_ms >= 50);
    assert.ok(Date.now() - started < 500);
    resolveHang?.();
  });

  it("completes before budget when refresh is fast", async () => {
    const result = await boundedPacketObservationRefresh({
      budgetMs: 500,
      observationFresh: false,
      refresh: async () => undefined,
    });
    assert.equal(result.timed_out, false);
    assert.ok(result.waited_ms < 500);
  });
});
