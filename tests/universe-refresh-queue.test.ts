import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UniverseRefreshQueue } from "../src/market/universe-refresh-queue.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("UniverseRefreshQueue", () => {
  it("coalesces queued refreshes for the same contract key", async () => {
    const occupy = deferred();
    let runs = 0;
    const queue = new UniverseRefreshQueue({ maxQueueDepth: 8 });
    void queue.enqueue({
      coalesceKey: "CON.F.US.MNQ.U26",
      targetContract: "CON.F.US.MNQ.U26",
      refresh: async () => {
        runs += 1;
        await occupy.promise;
      },
      buildResult: () => "running",
    });
    await Promise.resolve();
    const coalescedA = queue.enqueue({
      coalesceKey: "CON.F.US.MNQ.U26",
      targetContract: "CON.F.US.MNQ.U26",
      refresh: async () => {
        runs += 1;
      },
      buildResult: () => "a",
    });
    const coalescedB = queue.enqueue({
      coalesceKey: "CON.F.US.MNQ.U26",
      targetContract: "CON.F.US.MNQ.U26",
      refresh: async () => {
        runs += 1;
      },
      buildResult: () => "b",
    });
    occupy.resolve();
    assert.deepEqual(await Promise.all([coalescedA, coalescedB]), ["a", "b"]);
    await queue.waitForIdle();
    assert.equal(runs, 2, "running job plus one coalesced queued job");
  });

  it("does not coalesce against an already-running refresh for the same contract", async () => {
    const firstGate = deferred();
    let runs = 0;
    const queue = new UniverseRefreshQueue();
    const first = queue.enqueue({
      coalesceKey: "CON.F.US.MNQ.U26",
      targetContract: "CON.F.US.MNQ.U26",
      refresh: async () => {
        runs += 1;
        await firstGate.promise;
      },
      buildResult: () => "first",
    });
    await Promise.resolve();
    const second = queue.enqueue({
      coalesceKey: "CON.F.US.MNQ.U26",
      targetContract: "CON.F.US.MNQ.U26",
      refresh: async () => {
        runs += 1;
      },
      buildResult: () => "second",
    });
    firstGate.resolve();
    const [firstValue, secondValue] = await Promise.all([first, second]);
    await queue.waitForIdle();
    assert.equal(runs, 2);
    assert.equal(firstValue, "first");
    assert.equal(secondValue, "second");
  });

  it("rejects callers when the queue is full", async () => {
    const occupy = deferred();
    const queue = new UniverseRefreshQueue({ maxQueueDepth: 1 });
    void queue.enqueue({
      coalesceKey: "running",
      targetContract: "running",
      refresh: async () => {
        await occupy.promise;
      },
      buildResult: () => undefined,
    });
    await Promise.resolve();
    void queue.enqueue({
      coalesceKey: "queued-a",
      targetContract: "queued-a",
      refresh: async () => undefined,
      buildResult: () => undefined,
    });
    await assert.rejects(
      () => queue.enqueue({
        coalesceKey: "queued-b",
        targetContract: "queued-b",
        refresh: async () => undefined,
        buildResult: () => undefined,
      }),
      /universe_refresh_queue_full/,
    );
    occupy.resolve();
    await queue.waitForIdle();
  });

  it("times out waiters that exceed the queue wait budget", async () => {
    let nowMs = 0;
    const occupy = deferred();
    const queue = new UniverseRefreshQueue({
      maxQueueDepth: 4,
      queueWaitTimeoutMs: 100,
      now: () => nowMs,
    });
    void queue.enqueue({
      coalesceKey: "running",
      targetContract: "running",
      refresh: async () => {
        await occupy.promise;
      },
      buildResult: () => "running",
    });
    await Promise.resolve();
    const late = queue.enqueue({
      coalesceKey: "starved",
      targetContract: "starved",
      refresh: async () => undefined,
      buildResult: () => "late",
    });
    await Promise.resolve();
    nowMs = 200;
    void queue.enqueue({
      coalesceKey: "probe",
      targetContract: "probe",
      refresh: async () => undefined,
      buildResult: () => "probe",
    });
    await assert.rejects(late, /universe_refresh_queue_timeout/);
    occupy.resolve();
    await queue.waitForIdle();
  });

  it("retries after a failed refresh without accumulating infinite jobs", async () => {
    let runs = 0;
    const queue = new UniverseRefreshQueue();
    const first = queue.enqueue({
      coalesceKey: "CON.F.US.MES.U26",
      targetContract: "CON.F.US.MES.U26",
      refresh: async () => {
        runs += 1;
        throw new Error("provider slow");
      },
      buildResult: () => "unused",
    });
    await assert.rejects(first, /provider slow/);
    const second = queue.enqueue({
      coalesceKey: "CON.F.US.MES.U26",
      targetContract: "CON.F.US.MES.U26",
      refresh: async () => {
        runs += 1;
      },
      buildResult: () => "recovered",
    });
    assert.equal(await second, "recovered");
    await queue.waitForIdle();
    assert.equal(runs, 2);
    assert.equal(queue.backlog(), 0);
  });

  it("logs backlog, job_id, target contract, and duration", async () => {
    const logs: string[] = [];
    const queue = new UniverseRefreshQueue({
      onLog: (entry) => {
        logs.push(`${entry.event}:${entry.target_contract}:${entry.backlog}:${entry.job_id.length > 0}:${entry.duration_ms ?? 0}`);
      },
    });
    await queue.enqueue({
      coalesceKey: "CON.F.US.MCL.V26",
      targetContract: "CON.F.US.MCL.V26",
      refresh: async () => undefined,
      buildResult: () => "done",
    });
    await queue.waitForIdle();
    assert.ok(logs.some((line) => line.startsWith("enqueued:CON.F.US.MCL.V26:")));
    assert.ok(logs.some((line) => line.startsWith("started:CON.F.US.MCL.V26:")));
    assert.ok(logs.some((line) => line.startsWith("completed:CON.F.US.MCL.V26:") && line.includes(":true:")));
  });
});
