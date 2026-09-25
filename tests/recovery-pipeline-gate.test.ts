import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RecoveryPipelineGate } from "../src/service/recovery-pipeline-gate.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("RecoveryPipelineGate (TS-STREAM-RECOVERY-01 item 2)", () => {
  it("user+market reconnect during one run produce at most one trailing pass", async () => {
    const gate = new RecoveryPipelineGate();
    let runs = 0;
    const first = deferred();
    const execute = async () => {
      runs += 1;
      if (runs === 1) {
        await first.promise;
      }
    };
    const user = gate.run(execute);
    await Promise.resolve();
    const market = gate.run(execute);
    const extra = gate.run(execute);
    first.resolve();
    await Promise.all([user, market, extra]);
    assert.equal(runs, 2, "in-flight plus one trailing pass, not one execute per reconnect");
  });

  it("joiners wait until the trailing pass finishes", async () => {
    const gate = new RecoveryPipelineGate();
    const order: string[] = [];
    const first = deferred();
    let runs = 0;
    const execute = async () => {
      runs += 1;
      order.push(`pass-${runs}-start`);
      if (runs === 1) {
        await first.promise;
      }
      order.push(`pass-${runs}-end`);
    };
    const user = gate.run(execute);
    await Promise.resolve();
    const market = gate.run(execute);
    first.resolve();
    await Promise.all([user, market]);
    assert.deepEqual(order, ["pass-1-start", "pass-1-end", "pass-2-start", "pass-2-end"]);
  });

  it("skips invalidate reconcile while hub recovery or the gate is already running", () => {
    assert.equal(RecoveryPipelineGate.shouldSkipInvalidateReconcile({
      pipelineRunning: false,
      hubRecoveryActive: false,
    }), false);
    assert.equal(RecoveryPipelineGate.shouldSkipInvalidateReconcile({
      pipelineRunning: true,
      hubRecoveryActive: false,
    }), true);
    assert.equal(RecoveryPipelineGate.shouldSkipInvalidateReconcile({
      pipelineRunning: false,
      hubRecoveryActive: true,
    }), true);
  });

  it("sequential runs after idle each execute once", async () => {
    const gate = new RecoveryPipelineGate();
    let runs = 0;
    await gate.run(async () => {
      runs += 1;
    });
    await gate.run(async () => {
      runs += 1;
    });
    assert.equal(runs, 2);
  });
});
