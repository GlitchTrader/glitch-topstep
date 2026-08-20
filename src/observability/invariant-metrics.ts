import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { ProtectedReductionHealth } from "../execution/protected-reduction-saga.js";
import type { EvidenceQueueMetrics } from "../projectx/evidence-write-queue.js";
import type { ProjectXAuthStatus } from "../projectx/auth-manager.js";

export interface InvariantMetrics {
  unprotected_open_quantity: number;
  unprotected_seconds_estimate: number | null;
  flatten_pending_seconds: number | null;
  auth_refresh_failures: number;
  auth_degraded: boolean;
  auth_refresh_in_flight: boolean;
  reconciliation_age_ms: number | null;
  evidence_queue_depth: number;
  evidence_queue_degraded: boolean;
  non_terminal_controls: number;
  execution_recovery_blocking: boolean;
  orphan_protective_orders: number;
}

export interface InvariantMetricsInput {
  snapshot: AccountVenueSnapshot;
  auth: ProjectXAuthStatus;
  protectedReduction: ProtectedReductionHealth;
  evidenceQueue: EvidenceQueueMetrics;
  recovery: ExecutionRecoveryStatus;
  controlCounts: { pending: number; applying: number };
  flattenPendingAgeMs: number | null;
  now?: Date;
}

export function buildInvariantMetrics(input: InvariantMetricsInput): InvariantMetrics {
  const now = input.now ?? new Date();
  const reconciliation = input.snapshot.operational.reconciliation;
  const reconciliationAgeMs = reconciliation.lastSucceededAt
    ? Math.max(0, now.getTime() - Date.parse(reconciliation.lastSucceededAt))
    : null;

  return {
    unprotected_open_quantity: input.protectedReduction.unprotected_open_quantity,
    unprotected_seconds_estimate: input.protectedReduction.ambiguous_age_ms === null
      ? null
      : Math.round(input.protectedReduction.ambiguous_age_ms / 1000),
    flatten_pending_seconds: input.flattenPendingAgeMs === null
      ? null
      : Math.round(input.flattenPendingAgeMs / 1000),
    auth_refresh_failures: input.auth.refreshFailureCount,
    auth_degraded: input.auth.degraded,
    auth_refresh_in_flight: input.auth.refreshInFlight,
    reconciliation_age_ms: reconciliationAgeMs,
    evidence_queue_depth: input.evidenceQueue.depth,
    evidence_queue_degraded: input.evidenceQueue.degraded,
    non_terminal_controls: input.controlCounts.pending + input.controlCounts.applying,
    execution_recovery_blocking: input.recovery.blockingNewExposure || input.recovery.blockingAmbiguity,
    orphan_protective_orders: input.protectedReduction.orphan_protective_orders,
  };
}
