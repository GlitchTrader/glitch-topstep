import type { InvariantMetrics } from "./invariant-metrics.js";

export interface HealthAlert {
  id: string;
  severity: "warning" | "critical";
  message: string;
}

export function buildHealthAlerts(metrics: InvariantMetrics): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  if (metrics.auth_degraded) {
    alerts.push({
      id: "auth_degraded",
      severity: "critical",
      message: "ProjectX auth is degraded; new exposure should remain blocked",
    });
  }
  if (metrics.evidence_queue_degraded) {
    alerts.push({
      id: "evidence_queue_degraded",
      severity: "warning",
      message: "Provider evidence queue is degraded",
    });
  }
  if (metrics.unprotected_open_quantity > 0) {
    alerts.push({
      id: "unprotected_open_quantity",
      severity: "critical",
      message: `Unprotected open quantity is ${metrics.unprotected_open_quantity}`,
    });
  }
  if (metrics.execution_recovery_blocking) {
    alerts.push({
      id: "execution_recovery_blocking",
      severity: "critical",
      message: "Execution recovery is blocking new exposure",
    });
  }
  if (metrics.supervisor_gate_divergence) {
    alerts.push({
      id: "supervisor_gate_divergence",
      severity: "warning",
      message: "Safety supervisor diverged from execution gates",
    });
  }
  return alerts;
}
