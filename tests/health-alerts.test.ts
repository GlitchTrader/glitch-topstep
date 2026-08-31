import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HealthAlertTracker } from "../src/observability/health-alerts.js";
import type { InvariantMetrics } from "../src/observability/invariant-metrics.js";

function metrics(overrides: Partial<InvariantMetrics> = {}): InvariantMetrics {
  return {
    unprotected_open_quantity: 0,
    unprotected_seconds_estimate: null,
    flatten_pending_seconds: null,
    auth_refresh_failures: 0,
    auth_degraded: false,
    auth_refresh_in_flight: false,
    reconciliation_age_ms: null,
    evidence_queue_depth: 0,
    evidence_queue_physical_depth: 0,
    evidence_queue_degraded: false,
    rest_snapshot_cache_size: 0,
    rest_snapshot_cache_max: 0,
    rest_snapshot_cache_evictions: 0,
    supervisor_gate_divergence: false,
    non_terminal_controls: 0,
    execution_recovery_blocking: false,
    orphan_protective_orders: 0,
    ...overrides,
  };
}

describe("HealthAlertTracker (TS-REAUDIT-11)", () => {
  it("does not report a single-evaluation blip -- that's the whole point of hysteresis", () => {
    const tracker = new HealthAlertTracker(2, 2);
    const alerts = tracker.evaluate(metrics({ auth_degraded: true }));
    assert.equal(alerts.length, 0);
  });

  it("opens only after the open threshold is reached, then stays open on repeat", () => {
    const tracker = new HealthAlertTracker(2, 2);
    tracker.evaluate(metrics({ auth_degraded: true }));
    const opened = tracker.evaluate(metrics({ auth_degraded: true }));
    const authAlert = opened.find((a) => a.alert_id === "auth_degraded");
    assert.ok(authAlert, "expected auth_degraded to open on the 2nd consecutive evaluation");
    assert.equal(authAlert!.recovery_state, "open");
    assert.equal(authAlert!.severity, "critical");
    assert.ok(authAlert!.first_fired_utc);
    assert.equal(authAlert!.dedup_key, "auth_degraded");

    const stillOpen = tracker.evaluate(metrics({ auth_degraded: true }));
    assert.equal(stillOpen.find((a) => a.alert_id === "auth_degraded")?.recovery_state, "open");
  });

  it("does not re-open (does not reset first_fired_utc) while continuously active", () => {
    const tracker = new HealthAlertTracker(1, 2);
    const first = tracker.evaluate(metrics({ auth_degraded: true }));
    const firstFired = first.find((a) => a.alert_id === "auth_degraded")!.first_fired_utc;
    const second = tracker.evaluate(metrics({ auth_degraded: true }));
    assert.equal(second.find((a) => a.alert_id === "auth_degraded")!.first_fired_utc, firstFired);
  });

  it("clears only after the clear threshold of consecutive clean evaluations, reporting 'clearing' in between", () => {
    const tracker = new HealthAlertTracker(1, 2);
    tracker.evaluate(metrics({ auth_degraded: true })); // opens immediately (threshold 1)
    const clearing = tracker.evaluate(metrics({ auth_degraded: false }));
    const clearingAlert = clearing.find((a) => a.alert_id === "auth_degraded");
    assert.ok(clearingAlert, "expected the alert to still be reported while clearing");
    assert.equal(clearingAlert!.recovery_state, "clearing");

    const cleared = tracker.evaluate(metrics({ auth_degraded: false }));
    assert.ok(!cleared.some((a) => a.alert_id === "auth_degraded"), "must be gone once fully cleared");
  });

  it("a brief recovery mid-clear does not reset the open state's memory unexpectedly", () => {
    const tracker = new HealthAlertTracker(1, 3);
    tracker.evaluate(metrics({ auth_degraded: true })); // open
    tracker.evaluate(metrics({ auth_degraded: false })); // clearing (1/3)
    const backActive = tracker.evaluate(metrics({ auth_degraded: true })); // active again
    assert.equal(backActive.find((a) => a.alert_id === "auth_degraded")?.recovery_state, "open");
  });

  it("wires the numeric SLI thresholds from docs/OPERATIONS.md: unprotected_seconds_estimate", () => {
    const tracker = new HealthAlertTracker(1, 1);
    const warn = tracker.evaluate(metrics({ unprotected_seconds_estimate: 31 }));
    assert.ok(warn.some((a) => a.alert_id === "unprotected_seconds_estimate_warn"));
    assert.ok(!warn.some((a) => a.alert_id === "unprotected_seconds_estimate_critical"));

    const critical = tracker.evaluate(metrics({ unprotected_seconds_estimate: 121 }));
    assert.ok(critical.some((a) => a.alert_id === "unprotected_seconds_estimate_critical"));
  });

  it("wires flatten_pending_seconds and reconciliation_age_ms thresholds", () => {
    const tracker = new HealthAlertTracker(1, 1);
    const alerts = tracker.evaluate(metrics({
      flatten_pending_seconds: 46,
      reconciliation_age_ms: 120_001,
    }));
    assert.ok(alerts.some((a) => a.alert_id === "flatten_pending_seconds_warn"));
    assert.ok(alerts.some((a) => a.alert_id === "reconciliation_age_warn"));
    assert.ok(!alerts.some((a) => a.alert_id === "flatten_pending_seconds_critical"));
  });

  it("every reported alert carries a runbook_url", () => {
    const tracker = new HealthAlertTracker(1, 1);
    const alerts = tracker.evaluate(metrics({ auth_degraded: true, evidence_queue_degraded: true }));
    for (const alert of alerts) {
      assert.ok(alert.runbook_url.length > 0);
    }
  });

  it("tracks independent alerts independently", () => {
    const tracker = new HealthAlertTracker(1, 1);
    const alerts = tracker.evaluate(metrics({ auth_degraded: true, unprotected_open_quantity: 1 }));
    assert.ok(alerts.some((a) => a.alert_id === "auth_degraded"));
    assert.ok(alerts.some((a) => a.alert_id === "unprotected_open_quantity"));
    assert.equal(alerts.length, 2);
  });
});
