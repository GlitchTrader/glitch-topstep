import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HubRecoveryController, idleHubRecoverySnapshot } from "../src/projectx/hub-recovery-controller.js";
import { shouldWatchdogRestartGateway } from "../src/observability/gateway-watchdog-policy.js";

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

  it("keeps generation, deadline, and last_progress across fail retries of the same drop", () => {
    const controller = new HubRecoveryController(120_000);
    const gen1 = controller.beginAttempt("market", "suspect", "2026-09-24T22:00:00.000Z");
    assert.equal(controller.fail(gen1, "2026-09-24T22:00:10.000Z"), true);
    const snapFailed = controller.snapshot();
    assert.equal(snapFailed.active, true);
    assert.equal(snapFailed.phase, "failed");
    assert.equal(snapFailed.last_progress_at, "2026-09-24T22:00:00.000Z");
    assert.equal(snapFailed.deadline_at, "2026-09-24T22:02:00.000Z");
    const gen2 = controller.beginAttempt("market", "suspect", "2026-09-24T22:00:11.000Z");
    assert.equal(gen2, 1);
    assert.equal(controller.isStaleCallback(gen1), false);
    const snap = controller.snapshot();
    assert.equal(snap.generation, 1);
    assert.equal(snap.attempt, 2);
    assert.equal(snap.phase, "suspect");
    assert.equal(snap.started_at, "2026-09-24T22:00:00.000Z");
    assert.equal(snap.last_progress_at, "2026-09-24T22:00:00.000Z");
    assert.equal(snap.deadline_at, "2026-09-24T22:02:00.000Z");
  });

  it("does not treat beginAttempt as progress while already recovering", () => {
    const controller = new HubRecoveryController(120_000);
    const gen1 = controller.beginAttempt("user", "suspect", "2026-09-27T02:15:00.000Z");
    controller.beginAttempt("user", "suspect", "2026-09-27T02:16:00.000Z");
    controller.beginAttempt("user", "suspect", "2026-09-27T02:17:00.000Z");
    const snap = controller.snapshot();
    assert.equal(snap.generation, gen1);
    assert.equal(snap.attempt, 3);
    assert.equal(snap.last_progress_at, "2026-09-27T02:15:00.000Z");
    assert.equal(snap.deadline_at, "2026-09-27T02:17:00.000Z");
    assert.equal(controller.markProgress("resubscribing", gen1, "2026-09-27T02:15:20.000Z"), true);
    assert.equal(controller.snapshot().last_progress_at, "2026-09-27T02:15:20.000Z");
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

  it("exposes a stale snapshot the process watchdog would restart", () => {
    const t0 = new Date(Date.now() - 8 * 60 * 1000).toISOString();
    const controller = new HubRecoveryController(120_000);
    const gen = controller.beginAttempt("market", "suspect", t0);
    controller.fail(gen, new Date(Date.now() - 7 * 60 * 1000).toISOString());
    controller.beginAttempt("market", "suspect", new Date(Date.now() - 6 * 60 * 1000).toISOString());
    controller.fail(gen, new Date(Date.now() - 5 * 60 * 1000).toISOString());
    controller.beginAttempt("market", "suspect", new Date().toISOString());
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "market_stream_disconnected"] },
        recovery: controller.snapshot(),
      }),
      true,
    );
  });

  it("does not expose a restart to the watchdog after real resubscribe progress", () => {
    const t0 = new Date(Date.now() - 180_000).toISOString();
    const controller = new HubRecoveryController(120_000);
    const gen = controller.beginAttempt("market", "suspect", t0);
    controller.markProgress("resubscribing", gen, new Date().toISOString());
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "market_stream_reconnecting"] },
        recovery: controller.snapshot(),
      }),
      false,
    );
  });
});
