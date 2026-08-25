import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { ProtectedReductionHealth } from "../src/execution/protected-reduction-saga.js";
import { buildInvariantMetrics } from "../src/observability/invariant-metrics.js";
import type { EvidenceQueueMetrics } from "../src/projectx/evidence-write-queue.js";
import { snapshot } from "./fixtures.js";

const recovery: ExecutionRecoveryStatus = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

const protectedReduction: ProtectedReductionHealth = {
  active_state: null,
  active_reduction_id: null,
  unprotected_open_quantity: 2,
  orphan_protective_orders: 1,
  ambiguous_age_ms: 12_000,
  fail_closed_rollback: false,
};

const evidenceQueue: EvidenceQueueMetrics = {
  depth: 3,
  physical_depth: 3,
  identity_depth: 0,
  oldest_age_ms: 1_000,
  degraded: true,
  high_water_mark: 100,
  coalesce_watermark: 50,
  high_water_hits: 1,
  enqueued: 10,
  persisted: 7,
  coalesced: { identity: 0, quote: 0, depth: 0, print: 0 },
  dropped: { identity: 0, quote: 0, depth: 0, print: 0 },
  last_batch_size: 1,
  last_write_latency_ms: 2,
  max_write_latency_ms: 5,
  write_failures: 0,
  consecutive_write_failures: 0,
  apply_failures: 0,
  resume_cursor: null,
  closed: false,
  incomplete_shutdown: false,
};

test("TS-AUDIT-14 invariant metrics expose trading risk signals without secrets", () => {
  const venue = snapshot();
  venue.operational.reconciliation.lastSucceededAt = new Date(Date.now() - 5_000).toISOString();
  const metrics = buildInvariantMetrics({
    snapshot: venue,
    auth: {
      degraded: true,
      lastRefreshUtc: null,
      expiresAtUtc: null,
      refreshInFlight: false,
      refreshFailureCount: 2,
    },
    protectedReduction,
    evidenceQueue,
    recovery,
    controlCounts: { pending: 1, applying: 0 },
    flattenPendingAgeMs: 45_000,
  });
  assert.equal(metrics.unprotected_open_quantity, 2);
  assert.equal(metrics.unprotected_seconds_estimate, 12);
  assert.equal(metrics.flatten_pending_seconds, 45);
  assert.equal(metrics.auth_refresh_failures, 2);
  assert.equal(metrics.auth_degraded, true);
  assert.equal(metrics.evidence_queue_depth, 3);
  assert.equal(metrics.evidence_queue_physical_depth, 3);
  assert.equal(metrics.evidence_queue_degraded, true);
  assert.equal(metrics.non_terminal_controls, 1);
  assert.equal(metrics.orphan_protective_orders, 1);
  assert.ok(metrics.reconciliation_age_ms !== null && metrics.reconciliation_age_ms >= 5_000);
});
