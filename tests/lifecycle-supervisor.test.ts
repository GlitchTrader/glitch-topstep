import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleSupervisor, requiresShutdownRetention } from "../src/service/lifecycle-supervisor.js";

test("startup rollback disposes registered resources in reverse order and parks in failed_startup", async () => {
  const supervisor = new LifecycleSupervisor();
  const disposed: string[] = [];
  supervisor.transition("starting");
  supervisor.register("lock", () => {
    disposed.push("lock");
  });
  supervisor.register("realtime", async () => {
    await Promise.resolve();
    disposed.push("realtime");
  });
  supervisor.register("gateway", () => {
    disposed.push("gateway");
  });

  const status = await supervisor.rollbackAfterFailure("login_failed");

  assert.deepEqual(disposed, ["gateway", "realtime", "lock"]);
  assert.equal(status.state, "failed_startup");
  assert.equal(status.detail, "login_failed");
  assert.deepEqual(supervisor.registeredNames(), []);
  assert.equal(supervisor.status().state, "failed_startup");
});

test("a failing disposer never blocks resources acquired before it", async () => {
  const supervisor = new LifecycleSupervisor();
  const disposed: string[] = [];
  supervisor.register("store", () => {
    disposed.push("store");
  });
  supervisor.register("gateway", () => {
    throw new Error("gateway_stop_failed");
  });

  const status = await supervisor.rollbackAfterFailure("boom");

  assert.deepEqual(disposed, ["store"]);
  assert.equal(status.state, "failed_startup");
  assert.equal(status.detail, "boom;dispose_failed:gateway");
});

test("drain enters draining, unwinds in reverse and leaves the terminal state to the caller", async () => {
  const supervisor = new LifecycleSupervisor();
  const disposed: string[] = [];
  supervisor.transition("ready");
  supervisor.register("timer", () => {
    disposed.push("timer");
  });
  supervisor.register("gateway", () => {
    disposed.push("gateway");
  });

  const result = await supervisor.drain("stop_requested");

  assert.deepEqual(result, { failed: [], criticalFailed: [] });
  assert.deepEqual(disposed, ["gateway", "timer"]);
  assert.equal(supervisor.status().state, "draining");
  assert.equal(supervisor.status().detail, "stop_requested");

  supervisor.transition("stopped");
  assert.equal(supervisor.status().state, "stopped");
  assert.deepEqual(await supervisor.drain(), { failed: [], criticalFailed: [] });
});

test("critical disposer failure is surfaced separately (TS-REAUDIT-08)", async () => {
  const supervisor = new LifecycleSupervisor();
  supervisor.register("timer", () => undefined);
  supervisor.register("realtime", () => {
    throw new Error("stream_stop_failed");
  }, { critical: true });

  const result = await supervisor.drain("stop_requested");
  assert.deepEqual(result.failed, ["realtime"]);
  assert.deepEqual(result.criticalFailed, ["realtime"]);
  assert.ok(supervisor.registeredNames().includes("realtime"));
});

test("requiresShutdownRetention retains on critical disposer failure even with an empty backlog (TS-REAUDIT-08)", () => {
  // This is the exact gap that let closeStores() release the runtime lock and close stores
  // while a critical disposer (e.g. realtime) still had a live writer: the retention decision
  // only looked at durable backlog, never at whether a critical disposer actually failed.
  assert.equal(requiresShutdownRetention(["realtime"], false), true);
});

test("requiresShutdownRetention retains on durable backlog even with no critical failure", () => {
  assert.equal(requiresShutdownRetention([], true), true);
});

test("requiresShutdownRetention retains when both conditions hold", () => {
  assert.equal(requiresShutdownRetention(["local_gateway"], true), true);
});

test("requiresShutdownRetention allows cleanup only when neither condition holds", () => {
  assert.equal(requiresShutdownRetention([], false), false);
});
