import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldWatchdogRestartGateway,
  watchdogRestartCause,
  isRecoveryProgressFresh,
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
});
