import assert from "node:assert/strict";
import test from "node:test";
import { RestConcurrencyGate } from "../src/projectx/rest-concurrency.js";

test("RestConcurrencyGate snapshot reports in-flight and waiters", async () => {
  const gate = new RestConcurrencyGate(1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gate.run(() => held);
  await Promise.resolve();
  const waiting = gate.run(async () => undefined);
  assert.deepEqual(gate.snapshot(), { in_flight: 1, waiting: 1, max_concurrent: 1 });
  release();
  await first;
  await waiting;
  assert.deepEqual(gate.snapshot(), { in_flight: 0, waiting: 0, max_concurrent: 1 });
});

test("RestConcurrencyGate wakes critical_reconcile ahead of queued retrieveBars", async () => {
  const gate = new RestConcurrencyGate(1);
  const order: string[] = [];
  let releaseHold!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const hold = gate.run(async () => {
    order.push("hold");
    await held;
  }, "history_sync");
  await Promise.resolve();
  const bars = gate.run(async () => {
    order.push("bars");
  }, "history_sync");
  const reconcile = gate.run(async () => {
    order.push("reconcile");
  }, "critical_reconcile");
  await Promise.resolve();
  assert.equal(gate.snapshot().waiting, 2);
  releaseHold();
  await Promise.all([hold, bars, reconcile]);
  assert.deepEqual(order, ["hold", "reconcile", "bars"]);
});
