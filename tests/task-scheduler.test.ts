import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskScheduler } from "../src/service/task-scheduler.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TaskScheduler (TS-STREAM-RECOVERY-01 PR-F)", () => {
  it("runs the higher-priority task first when both are queued ahead of any capacity", async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 1 });
    const order: string[] = [];
    const historyGate = deferred();
    // Occupy the single slot first with something we control, so both real requests queue.
    scheduler.enqueue("history_sync", "occupy", async () => {
      order.push("occupy-start");
      await historyGate.promise;
      order.push("occupy-end");
    });
    scheduler.enqueue("history_sync", "history", async () => {
      order.push("history");
    });
    scheduler.enqueue("critical_reconcile", "reconcile", async () => {
      order.push("reconcile");
    });
    historyGate.resolve();
    await scheduler.waitForIdle();
    assert.deepEqual(order, ["occupy-start", "occupy-end", "reconcile", "history"]);
  });

  it("caps concurrency at maxConcurrent -- a 3rd task waits for a slot", async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 2 });
    const running: string[] = [];
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    scheduler.enqueue("order_flow", "a", async () => {
      running.push("a-start");
      await gates.a.promise;
    });
    scheduler.enqueue("order_flow", "b", async () => {
      running.push("b-start");
      await gates.b.promise;
    });
    scheduler.enqueue("order_flow", "c", async () => {
      running.push("c-start");
      await gates.c.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(running, ["a-start", "b-start"], "c must not start while 2 are already running");
    assert.equal(scheduler.counts().running, 2);
    assert.equal(scheduler.counts().queued, 1);
    gates.a.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(running.includes("c-start"), "c starts once a slot frees up");
    gates.b.resolve();
    gates.c.resolve();
    await scheduler.waitForIdle();
  });

  it("coalesces a duplicate id already queued instead of running it twice", async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 1 });
    let runs = 0;
    const occupyGate = deferred();
    scheduler.enqueue("history_sync", "occupy", async () => {
      await occupyGate.promise;
    });
    scheduler.enqueue("history_sync", "history", async () => {
      runs += 1;
    });
    scheduler.enqueue("history_sync", "history", async () => {
      runs += 1;
    });
    occupyGate.resolve();
    await scheduler.waitForIdle();
    assert.equal(runs, 1, "the second enqueue with the same id must be coalesced");
  });

  it("promotes a task past its deadline ahead of nominally higher-priority newcomers (starvation guard)", async () => {
    let nowMs = 0;
    const scheduler = new TaskScheduler({ maxConcurrent: 1, now: () => nowMs });
    const order: string[] = [];
    const occupyGate = deferred();
    scheduler.enqueue("history_sync", "occupy", async () => {
      await occupyGate.promise;
    });
    // Low-priority task queued while the slot is busy, with a short deadline.
    scheduler.enqueue("history_sync", "starved", async () => {
      order.push("starved");
    }, 100);
    nowMs = 200; // past the starved task's deadline
    // A higher-priority task arrives after the deadline has already passed.
    scheduler.enqueue("critical_reconcile", "newcomer", async () => {
      order.push("newcomer");
    });
    occupyGate.resolve();
    await scheduler.waitForIdle();
    assert.deepEqual(order, ["starved", "newcomer"]);
    assert.equal(scheduler.counts().deferred, 1);
  });

  it("an isolated task failure does not block the queue, and is counted", async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 1, onError: () => {} });
    const order: string[] = [];
    scheduler.enqueue("order_flow", "fails", async () => {
      order.push("fails");
      throw new Error("boom");
    });
    scheduler.enqueue("order_flow", "next", async () => {
      order.push("next");
    });
    await scheduler.waitForIdle();
    assert.deepEqual(order, ["fails", "next"]);
    assert.equal(scheduler.counts().failed, 1);
    assert.equal(scheduler.counts().completed, 1);
  });

  it("waitForIdle resolves only once the queue and all running tasks are drained", async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 2 });
    const gate = deferred();
    let finished = false;
    scheduler.enqueue("market_observation", "slow", async () => {
      await gate.promise;
      finished = true;
    });
    const idle = scheduler.waitForIdle().then(() => {
      assert.equal(finished, true, "waitForIdle must not resolve before the running task finishes");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    gate.resolve();
    await idle;
  });

  it("counts reflect current state precisely", async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 1 });
    const gate = deferred();
    scheduler.enqueue("history_sync", "a", async () => {
      await gate.promise;
    });
    scheduler.enqueue("history_sync", "b", async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(scheduler.counts().running, 1);
    assert.equal(scheduler.counts().queued, 1);
    gate.resolve();
    await scheduler.waitForIdle();
    assert.equal(scheduler.counts().completed, 2);
    assert.equal(scheduler.counts().running, 0);
    assert.equal(scheduler.counts().queued, 0);
  });
});
