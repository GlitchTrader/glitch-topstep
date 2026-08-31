import type { InvariantMetrics } from "./invariant-metrics.js";

export type AlertSeverity = "warning" | "critical";
export type AlertRecoveryState = "opening" | "open" | "clearing" | "cleared";

export interface HealthAlert {
  alert_id: string;
  severity: AlertSeverity;
  message: string;
  dedup_key: string;
  recovery_state: AlertRecoveryState;
  first_fired_utc: string | null;
  last_fired_utc: string | null;
  open_threshold_evaluations: number;
  clear_threshold_evaluations: number;
  runbook_url: string;
}

interface RawAlertSignal {
  id: string;
  severity: AlertSeverity;
  message: string;
  runbook_url: string;
  active: boolean;
}

const OPERATIONS_RUNBOOK = "docs/OPERATIONS.md#runtime-slos-and-alerts-ts-reaudit-11";

function rawSignals(metrics: InvariantMetrics): RawAlertSignal[] {
  return [
    {
      id: "auth_degraded",
      severity: "critical",
      message: "ProjectX auth is degraded; new exposure should remain blocked",
      runbook_url: OPERATIONS_RUNBOOK,
      active: metrics.auth_degraded,
    },
    {
      id: "evidence_queue_degraded",
      severity: "warning",
      message: "Provider evidence queue is degraded",
      runbook_url: OPERATIONS_RUNBOOK,
      active: metrics.evidence_queue_degraded,
    },
    {
      id: "unprotected_open_quantity",
      severity: "critical",
      message: `Unprotected open quantity is ${metrics.unprotected_open_quantity}`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: metrics.unprotected_open_quantity > 0,
    },
    {
      id: "execution_recovery_blocking",
      severity: "critical",
      message: "Execution recovery is blocking new exposure",
      runbook_url: OPERATIONS_RUNBOOK,
      active: metrics.execution_recovery_blocking,
    },
    {
      id: "supervisor_gate_divergence",
      severity: "warning",
      message: "Safety supervisor diverged from execution gates",
      runbook_url: OPERATIONS_RUNBOOK,
      active: metrics.supervisor_gate_divergence,
    },
    {
      id: "unprotected_seconds_estimate_warn",
      severity: "warning",
      message: `Unprotected duration estimate is ${metrics.unprotected_seconds_estimate ?? 0}s (>30s)`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: (metrics.unprotected_seconds_estimate ?? 0) > 30,
    },
    {
      id: "unprotected_seconds_estimate_critical",
      severity: "critical",
      message: `Unprotected duration estimate is ${metrics.unprotected_seconds_estimate ?? 0}s (>120s)`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: (metrics.unprotected_seconds_estimate ?? 0) > 120,
    },
    {
      id: "flatten_pending_seconds_warn",
      severity: "warning",
      message: `Flatten has been pending ${metrics.flatten_pending_seconds ?? 0}s (>45s)`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: (metrics.flatten_pending_seconds ?? 0) > 45,
    },
    {
      id: "flatten_pending_seconds_critical",
      severity: "critical",
      message: `Flatten has been pending ${metrics.flatten_pending_seconds ?? 0}s (>180s)`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: (metrics.flatten_pending_seconds ?? 0) > 180,
    },
    {
      id: "reconciliation_age_warn",
      severity: "warning",
      message: `Reconciliation age is ${metrics.reconciliation_age_ms ?? 0}ms (>120000ms)`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: (metrics.reconciliation_age_ms ?? 0) > 120_000,
    },
    {
      id: "reconciliation_age_critical",
      severity: "critical",
      message: `Reconciliation age is ${metrics.reconciliation_age_ms ?? 0}ms (>300000ms)`,
      runbook_url: OPERATIONS_RUNBOOK,
      active: (metrics.reconciliation_age_ms ?? 0) > 300_000,
    },
  ];
}

interface TrackedAlert {
  consecutiveActive: number;
  consecutiveInactive: number;
  state: AlertRecoveryState;
  firstFiredUtc: string | null;
  lastFiredUtc: string | null;
}

/**
 * Stateful hysteresis/dedup wrapper around the raw per-evaluation alert signals (TS-REAUDIT-11).
 *
 * Hysteresis here is evaluation-count-based (N consecutive /health builds), not wall-clock-time
 * based: `/health` has no fixed polling interval this layer can rely on, and a tick-based gate is
 * simple to reason about and test precisely. `docs/OPERATIONS.md`'s SLO table describes a
 * wall-clock-second design intent for a future iteration; this implementation is the honestly
 * weaker (but real, non-flapping) evaluation-count version -- see the doc's own caveat.
 *
 * `evidence_queue_depth`'s numeric high/low-water thresholds and `auth_degraded`'s compound
 * "critical = degraded + a new-exposure attempt was made" condition are deliberately NOT
 * implemented: neither has an unambiguous definition derivable from InvariantMetrics alone, and
 * guessing thresholds for a safety alert is worse than leaving them as the existing boolean-only
 * checks (evidence_queue_degraded, auth_degraded) that were already correct.
 */
export class HealthAlertTracker {
  private readonly tracked = new Map<string, TrackedAlert>();

  public constructor(
    private readonly openThresholdEvaluations = 2,
    private readonly clearThresholdEvaluations = 2,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public evaluate(metrics: InvariantMetrics): HealthAlert[] {
    const nowUtc = this.now().toISOString();
    const alerts: HealthAlert[] = [];
    for (const signal of rawSignals(metrics)) {
      const existing = this.tracked.get(signal.id) ?? {
        consecutiveActive: 0,
        consecutiveInactive: 0,
        state: "cleared" as AlertRecoveryState,
        firstFiredUtc: null,
        lastFiredUtc: null,
      };

      if (signal.active) {
        existing.consecutiveActive += 1;
        existing.consecutiveInactive = 0;
        existing.lastFiredUtc = nowUtc;
        if (existing.state === "cleared" || existing.state === "clearing") {
          existing.state = existing.consecutiveActive >= this.openThresholdEvaluations
            ? "open"
            : "opening";
          if (existing.state === "open" && existing.firstFiredUtc === null) {
            existing.firstFiredUtc = nowUtc;
          }
        } else if (existing.state === "opening" && existing.consecutiveActive >= this.openThresholdEvaluations) {
          existing.state = "open";
          existing.firstFiredUtc ??= nowUtc;
        }
      } else {
        existing.consecutiveInactive += 1;
        existing.consecutiveActive = 0;
        if (existing.state === "open" || existing.state === "opening") {
          existing.state = existing.consecutiveInactive >= this.clearThresholdEvaluations
            ? "cleared"
            : "clearing";
        } else if (existing.state === "clearing" && existing.consecutiveInactive >= this.clearThresholdEvaluations) {
          existing.state = "cleared";
        }
      }

      this.tracked.set(signal.id, existing);

      // "opening" is deliberately not reported: it means the signal hasn't yet survived enough
      // consecutive evaluations to be trusted, which is the entire point of hysteresis. "clearing"
      // is still reported so a consumer can see an alert winding down rather than vanishing
      // instantly.
      if (existing.state === "open" || existing.state === "clearing") {
        alerts.push({
          alert_id: signal.id,
          severity: signal.severity,
          message: signal.message,
          dedup_key: signal.id,
          recovery_state: existing.state,
          first_fired_utc: existing.firstFiredUtc,
          last_fired_utc: existing.lastFiredUtc,
          open_threshold_evaluations: this.openThresholdEvaluations,
          clear_threshold_evaluations: this.clearThresholdEvaluations,
          runbook_url: signal.runbook_url,
        });
      }
    }
    return alerts;
  }
}

/** @deprecated Prefer a shared HealthAlertTracker instance for real hysteresis/dedup (TS-REAUDIT-11). */
export function buildHealthAlerts(metrics: InvariantMetrics): HealthAlert[] {
  return new HealthAlertTracker(1, 1).evaluate(metrics);
}
