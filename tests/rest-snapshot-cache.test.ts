import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRestSnapshotRecorder } from "../src/projectx/provider-event-recorder.js";

describe("TS-REAUDIT-05 rest snapshot cache", () => {
  it("bounds identity hash cache with LRU eviction", () => {
    const appended: number[] = [];
    const recorder = new ProviderRestSnapshotRecorder({
      append: () => {
        appended.push(1);
      },
    });
    const max = 4_096;
    for (let index = 0; index < max + 10; index += 1) {
      recorder.recordIfChanged({
        receivedUtc: "2026-08-21T12:00:00.000Z",
        eventType: "account_snapshot",
        generation: 1,
        accountId: index,
        contractId: "CON.F.US.MNQ.U26",
        normalizedPayload: { index },
      });
    }
    const metrics = recorder.cacheMetrics();
    assert.equal(metrics.size, max);
    assert.ok(metrics.evictions >= 10);
    assert.equal(appended.length, max + 10);
  });
});
