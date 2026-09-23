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
