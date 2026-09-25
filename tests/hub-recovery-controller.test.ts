import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HubRecoveryController, idleHubRecoverySnapshot } from "../src/projectx/hub-recovery-controller.js";

describe("HubRecoveryController", () => {
  it("tracks generation and ignores stale callbacks after complete", () => {
    const controller = new HubRecoveryController(120_000);
    const gen1 = controller.beginAttempt("market", "reconnecting", "2026-08-27T12:00:00.000Z");
    assert.equal(gen1, 1);
    assert.equal(controller.isStaleCallback(0), true);
    assert.equal(controller.markProgress("resubscribing", gen1, "2026-08-27T12:00:05.000Z"), true);
    const stillActive = controller.beginAttempt("market", "suspect", "2026-08-27T12:00:10.000Z");
    assert.equal(stillActive, 1);
    assert.equal(controller.isStaleCallback(gen1), false);
    assert.equal(controller.markProgress("reconciling", gen1, "2026-08-27T12:00:11.000Z"), true);
    assert.equal(controller.complete(gen1, "2026-08-27T12:00:30.000Z"), true);
    const snapshot = controller.snapshot();
    assert.equal(snapshot.active, false);
    assert.equal(snapshot.phase, "connected");
    assert.equal(snapshot.attempt, 2);
    const gen2 = controller.beginAttempt("market", "reconnecting", "2026-08-27T12:01:00.000Z");
    assert.equal(gen2, 2);
    assert.equal(controller.isStaleCallback(gen1), true);
  });

  it("keeps generation when beginAttempt repeats during active recovery", () => {
    const controller = new HubRecoveryController(120_000);
    const gen1 = controller.beginAttempt("user", "reconnecting", "2026-09-24T22:31:43.000Z");
    const gen2 = controller.beginAttempt("user", "suspect", "2026-09-24T22:32:33.000Z");
    const gen3 = controller.beginAttempt("user", "reconnecting", "2026-09-24T22:47:51.000Z");
    assert.equal(gen1, 1);
    assert.equal(gen2, 1);
    assert.equal(gen3, 1);
    assert.equal(controller.complete(gen1, "2026-09-24T22:48:00.000Z"), true);
    assert.equal(controller.snapshot().generation, 1);
    assert.equal(controller.snapshot().attempt, 3);
  });

  it("increments generation after fail", () => {
    const controller = new HubRecoveryController(120_000);
    const gen1 = controller.beginAttempt("market", "suspect", "2026-09-24T22:00:00.000Z");
    assert.equal(controller.fail(gen1, "2026-09-24T22:00:10.000Z"), true);
    const gen2 = controller.beginAttempt("market", "suspect", "2026-09-24T22:00:11.000Z");
    assert.equal(gen2, 2);
    assert.equal(controller.isStaleCallback(gen1), true);
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
