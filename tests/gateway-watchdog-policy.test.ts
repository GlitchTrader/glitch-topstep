import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldWatchdogRestartGateway,
  watchdogRestartCause,
  isRecoveryProgressFresh,
  startupOutboxDrainDecision,
  parseStartupOutboxDrainLine,
  recordStartupFailure,
  startupFailureBlocksRestart,
} from "../src/observability/gateway-watchdog-policy.js";

describe("gateway watchdog recovery policy", () => {
  it("restarts when health is unreachable", () => {
    assert.equal(shouldWatchdogRestartGateway(null), true);
  });

  it("does not restart when status is ok", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "ok",
        data_quality: { issues: ["quote_stale"] },
      }),
      false,
    );
  });

  it("restarts on degraded reconnecting streams with stale quotes", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: {
          issues: ["user_stream_reconnecting", "quote_stale"],
        },
      }),
      true,
    );
  });

  it("restarts on degraded reconciliation lag with stale quotes (streams may flap connected)", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: {
          issues: ["reconciliation_not_current", "quote_stale"],
        },
      }),
      true,
    );
  });

  it("does not restart degraded reconnecting without stale quotes", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["user_stream_reconnecting"] },
      }),
      false,
    );
  });

  it("does not restart degraded with only reconciliation_not_current (quiet market grace)", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["reconciliation_not_current"] },
      }),
      false,
    );
  });

  it("does not restart while hub recovery progress is fresh", () => {
    const now = Date.now();
    const recovery = {
      active: true,
      kind: "market",
      last_progress_at: new Date(now - 30_000).toISOString(),
      deadline_at: new Date(now + 120_000).toISOString(),
    };
    assert.equal(isRecoveryProgressFresh(recovery, now), true);
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "market_stream_reconnecting"] },
        recovery,
      }),
      false,
    );
    assert.equal(watchdogRestartCause({
      status: "degraded",
      data_quality: { issues: ["quote_stale", "market_stream_reconnecting"] },
      recovery,
    }), "recovery_progress_fresh");
  });

  it("restarts when recovery is active, progress stale, and deadline passed", () => {
    const now = Date.now();
    const recovery = {
      active: true,
      kind: "market",
      last_progress_at: new Date(now - 600_000).toISOString(),
      deadline_at: new Date(now - 60_000).toISOString(),
    };
    assert.equal(isRecoveryProgressFresh(recovery, now), false);
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "reconciliation_not_current"] },
        recovery,
      }),
      true,
    );
    assert.equal(watchdogRestartCause({
      status: "degraded",
      data_quality: { issues: ["quote_stale", "reconciliation_not_current"] },
      recovery,
    }), "recovery_stalled_past_deadline");
  });

  it("restarts a suspect/failed retry loop once clocks go stale", () => {
    const now = Date.now();
    const started = new Date(now - 8 * 60 * 1000).toISOString();
    const recovery = {
      active: true,
      kind: "market",
      phase: "suspect",
      started_at: started,
      last_progress_at: started,
      attempt: 45,
      deadline_at: new Date(now - 6 * 60 * 1000).toISOString(),
      generation: 1,
    };
    assert.equal(isRecoveryProgressFresh(recovery, now), false);
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "market_stream_disconnected"] },
        recovery,
      }),
      true,
    );
  });

  it("does not restart while recovery has real phase progress inside grace", () => {
    const now = Date.now();
    const recovery = {
      active: true,
      kind: "market",
      phase: "resubscribing",
      started_at: new Date(now - 180_000).toISOString(),
      last_progress_at: new Date(now - 20_000).toISOString(),
      attempt: 2,
      deadline_at: new Date(now - 60_000).toISOString(),
      generation: 1,
    };
    assert.equal(isRecoveryProgressFresh(recovery, now), true);
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["quote_stale", "market_stream_reconnecting"] },
        recovery,
      }),
      false,
    );
    assert.equal(watchdogRestartCause({
      status: "degraded",
      data_quality: { issues: ["quote_stale", "market_stream_reconnecting"] },
      recovery,
    }), "recovery_progress_fresh");
  });

  it("holds restart while a startup outbox drain is shrinking, even with no /health", () => {
    const previous = { pending: 5_000, drained_so_far: 1_000 };
    const current = { pending: 4_500, drained_so_far: 1_500 };
    assert.equal(startupOutboxDrainDecision(null, current), "hold");
    assert.equal(startupOutboxDrainDecision(previous, current), "hold");
    assert.equal(shouldWatchdogRestartGateway(null, { previous, current }), false);
    assert.equal(
      watchdogRestartCause(null, { previous, current }),
      "startup_outbox_drain_progressing",
    );
    const line = 'startup_outbox_drain {"pending":4500,"drained_so_far":1500,"pid":38112}';
    assert.deepEqual(parseStartupOutboxDrainLine(line), { ...current, pid: 38112 });
    assert.equal(
      startupOutboxDrainDecision(
        { pending: 4_000, drained_so_far: 5_000, pid: 21916 },
        { pending: 9_000, drained_so_far: 0, pid: 38112 },
      ),
      "hold",
    );
  });

  it("restarts when a startup outbox drain stops making progress", () => {
    const sample = { pending: 4_500, drained_so_far: 1_500 };
    assert.equal(startupOutboxDrainDecision(sample, sample), "stalled");
    assert.equal(shouldWatchdogRestartGateway(null, { previous: sample, current: sample }), true);
    assert.equal(
      watchdogRestartCause(null, { previous: sample, current: sample }),
      "startup_outbox_drain_stalled",
    );
  });

  it("stops restarting after the same startup failure repeats", () => {
    const first = recordStartupFailure({ cause: null, count: 0 }, "runtime_account_lock_held");
    const second = recordStartupFailure(first, "runtime_account_lock_held");
    const third = recordStartupFailure(second, "runtime_account_lock_held");
    assert.equal(startupFailureBlocksRestart(first), false);
    assert.equal(startupFailureBlocksRestart(second), false);
    assert.equal(startupFailureBlocksRestart(third), true);
    assert.deepEqual(third, { cause: "runtime_account_lock_held", count: 3 });
    const changed = recordStartupFailure(third, "dist_commit_mismatch");
    assert.deepEqual(changed, { cause: "dist_commit_mismatch", count: 1 });
    assert.equal(startupFailureBlocksRestart(changed), false);
  });

  it("still treats unreachable health with no drain evidence as a restart", () => {
    assert.equal(startupOutboxDrainDecision(null, null), "absent");
    assert.equal(startupOutboxDrainDecision(null, { pending: 0, drained_so_far: 800 }), "absent");
    assert.equal(shouldWatchdogRestartGateway(null, null), true);
    assert.equal(watchdogRestartCause(null), "health_unreachable");
  });
});
