import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedPacketObservationRefresh } from "../src/service/packet-observation-refresh.js";

const DEFAULT_BUDGET_MS = 4_000;

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

  it("slow refresh returns within 4s default budget", async () => {
    let clock = 0;
    const result = await boundedPacketObservationRefresh({
      budgetMs: DEFAULT_BUDGET_MS,
      observationFresh: false,
      refresh: () => new Promise(() => {}),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    assert.equal(result.timed_out, true);
    assert.equal(result.waited_ms, DEFAULT_BUDGET_MS);
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

  it("serial queue congestion does not block past budget", async () => {
    let releaseHead: (() => void) | undefined;
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let queued = 0;
    const serialRefresh = async () => {
      queued += 1;
      if (queued === 1) {
        await headGate;
      }
      await new Promise(() => {});
    };
    const started = Date.now();
    const result = await boundedPacketObservationRefresh({
      budgetMs: 60,
      observationFresh: false,
      refresh: serialRefresh,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    assert.equal(result.timed_out, true);
    assert.ok(Date.now() - started < 500);
    releaseHead?.();
  });

  it("concurrent waits each respect independent budgets", async () => {
    const hang = () => new Promise<void>(() => {});
    const budgetMs = 40;
    const started = Date.now();
    const results = await Promise.all([
      boundedPacketObservationRefresh({
        budgetMs,
        observationFresh: false,
        refresh: hang,
      }),
      boundedPacketObservationRefresh({
        budgetMs,
        observationFresh: false,
        refresh: hang,
      }),
      boundedPacketObservationRefresh({
        budgetMs,
        observationFresh: false,
        refresh: hang,
      }),
    ]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < budgetMs + 100);
    assert.ok(results.every((result) => result.timed_out));
  });

  it("/packet path never awaits refresh past budget (HTTP unblocked)", async () => {
    const refreshStarted = Date.now();
    const httpFinished = await boundedPacketObservationRefresh({
      budgetMs: 30,
      observationFresh: false,
      refresh: async () => {
        await new Promise(() => {});
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const elapsed = Date.now() - refreshStarted;
    assert.equal(httpFinished.timed_out, true);
    assert.ok(elapsed < 200);
  });
});
