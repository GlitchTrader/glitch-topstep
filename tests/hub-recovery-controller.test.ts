import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HubRecoveryController, idleHubRecoverySnapshot } from "../src/projectx/hub-recovery-controller.js";

describe("HubRecoveryController", () => {
  it("tracks generation and ignores stale callbacks", () => {
    const controller = new HubRecoveryController(120_000);
    const gen1 = controller.beginAttempt("market", "reconnecting", "2026-08-27T12:00:00.000Z");
    assert.equal(gen1, 1);
    assert.equal(controller.isStaleCallback(0), true);
    assert.equal(controller.markProgress("resubscribing", gen1, "2026-08-27T12:00:05.000Z"), true);
    const gen2 = controller.beginAttempt("market", "suspect", "2026-08-27T12:00:10.000Z");
    assert.equal(gen2, 2);
    assert.equal(controller.markProgress("resubscribing", gen1, "2026-08-27T12:00:11.000Z"), false);
    assert.equal(controller.complete(gen2, "2026-08-27T12:00:30.000Z"), true);
    const snapshot = controller.snapshot();
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.phase, "connected");
  });

  it("idle snapshot is inactive generation 0", () => {
    assert.deepEqual(idleHubRecoverySnapshot(), {
      active: false,
      kind: null,
      phase: "connected",
      started_at: null,
      last_progress_at: null,
      attempt: 0,
      deadline_at: null,
      generation: 0,
    });
  });

  it("reports deadline expiry", () => {
    const controller = new HubRecoveryController(1_000);
    controller.beginAttempt("market", "reconnecting", "2026-08-27T12:00:00.000Z");
    assert.equal(controller.deadlineExpired(Date.parse("2026-08-27T12:00:00.500Z")), false);
    assert.equal(controller.deadlineExpired(Date.parse("2026-08-27T12:00:02.000Z")), true);
  });
});
