import type { DurableControlStore } from "../control/durable-control-store.js";
import type { ProtectedReductionHealth } from "../execution/protected-reduction-saga.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { ProviderEvidenceStatus } from "../domain/provider-evidence.js";
import type { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { SqliteProviderEvidenceStore } from "../storage/sqlite-provider-evidence-store.js";
import type { TradeOutcomeStore } from "../storage/trade-outcome-store.js";

/**
 * Single choke point for SQLite touched by authenticated /health.
 * Reconcile heats; /health only peeks — any new health SQLite field must land here
 * so tests/authenticated-health-sqlite-isolation.test.ts fails before production stalls.
 */

export interface ProtectedReductionHealthCache {
  refreshProtectedReductionHealthCache(snapshot: AccountVenueSnapshot): ProtectedReductionHealth;
  peekProtectedReductionHealth(): ProtectedReductionHealth | null;
  isProtectedReductionHealthCacheStale(): boolean;
  isProtectedReductionHealthCacheWarmed(): boolean;
}

export interface AuthenticatedHealthSqliteStores {
  executionStore: SqliteExecutionStore;
  controlStore: DurableControlStore;
  tradeOutcomeStore: TradeOutcomeStore;
  providerEvidenceStore: SqliteProviderEvidenceStore;
  coordinator: ProtectedReductionHealthCache | null;
}

export interface AuthenticatedHealthSqliteFields {
  recoveryPeek: ReturnType<SqliteExecutionStore["peekRecoveryStatus"]>;
  recoveryCacheStale: boolean;
  unprotectedSinceUtc: string | null;
  unprotectedSinceCacheStale: boolean;
  controlCounts: ReturnType<DurableControlStore["peekStatus"]>;
  flattenPending: boolean;
  flattenPendingAgeMs: number | null;
  controlHealthCacheWarmed: boolean;
  controlHealthCacheStale: boolean;
  outcomeFeed: ReturnType<TradeOutcomeStore["peekStatus"]>;
  outcomeHealthCacheWarmed: boolean;
  outcomeHealthCacheStale: boolean;
  providerEvidence: ProviderEvidenceStatus;
  providerEvidenceHealthCacheWarmed: boolean;
  providerEvidenceHealthCacheStale: boolean;
  executionFacts: { live: number; superseded: number; high_water_sequence: number };
  executionFactsCacheWarmed: boolean;
  executionFactsCacheStale: boolean;
  protectedReduction: ProtectedReductionHealth;
  protectedReductionHealthCacheWarmed: boolean;
  protectedReductionHealthCacheStale: boolean;
}

const UNHEATED_PROTECTED_REDUCTION: ProtectedReductionHealth = {
  active_state: null,
  active_reduction_id: null,
  unprotected_open_quantity: 0,
  orphan_protective_orders: 0,
  ambiguous_age_ms: null,
  fail_closed_rollback: process.env.GLITCH_PARTIAL_EXIT_FAIL_CLOSED === "1",
};

const UNHEATED_EXECUTION_FACTS = {
  live: 0,
  superseded: 0,
  high_water_sequence: 0,
};

/** Heat every authenticated-/health SQLite peek. Call from reconcile, never from /health. */
export function refreshAuthenticatedHealthSqliteCaches(
  stores: AuthenticatedHealthSqliteStores,
  snapshot: AccountVenueSnapshot,
): ProtectedReductionHealth | null {
  const protectedReduction = stores.coordinator?.refreshProtectedReductionHealthCache(snapshot)
    ?? null;
  stores.executionStore.recoveryStatus();
  stores.executionStore.refreshExecutionFactsHealthCache();
  stores.controlStore.refreshHealthCache();
  stores.tradeOutcomeStore.refreshHealthCache();
  stores.providerEvidenceStore.refreshHealthCache();
  return protectedReduction;
}

/** Authenticated /health SQLite slice — must never call DatabaseSync.prepare. */
export function peekAuthenticatedHealthSqlite(
  stores: AuthenticatedHealthSqliteStores,
  nowMs = Date.now(),
): AuthenticatedHealthSqliteFields {
  const protectedPeek = stores.coordinator?.peekProtectedReductionHealth() ?? null;
  const factsPeek = stores.executionStore.peekExecutionFactsStatus();
  return {
    recoveryPeek: stores.executionStore.peekRecoveryStatus(),
    recoveryCacheStale: stores.executionStore.isRecoveryCacheStale(),
    unprotectedSinceUtc: stores.executionStore.peekUnprotectedSinceUtc(),
    unprotectedSinceCacheStale: stores.executionStore.isUnprotectedSinceCacheStale(),
    controlCounts: stores.controlStore.peekStatus(),
    flattenPending: stores.controlStore.peekHasPendingFlatten(),
    flattenPendingAgeMs: stores.controlStore.peekOldestPendingFlattenAgeMs(nowMs),
    controlHealthCacheWarmed: stores.controlStore.isHealthCacheWarmed(),
    controlHealthCacheStale: stores.controlStore.isHealthCacheStale(),
    outcomeFeed: stores.tradeOutcomeStore.peekStatus(),
    outcomeHealthCacheWarmed: stores.tradeOutcomeStore.isHealthCacheWarmed(),
    outcomeHealthCacheStale: stores.tradeOutcomeStore.isHealthCacheStale(),
    providerEvidence: stores.providerEvidenceStore.peekStatus(),
    providerEvidenceHealthCacheWarmed: stores.providerEvidenceStore.isHealthCacheWarmed(),
    providerEvidenceHealthCacheStale: stores.providerEvidenceStore.isHealthCacheStale(),
    executionFacts: factsPeek ?? UNHEATED_EXECUTION_FACTS,
    executionFactsCacheWarmed: stores.executionStore.isExecutionFactsCacheWarmed(),
    executionFactsCacheStale: stores.executionStore.isExecutionFactsCacheStale(),
    protectedReduction: protectedPeek ?? UNHEATED_PROTECTED_REDUCTION,
    protectedReductionHealthCacheWarmed:
      stores.coordinator?.isProtectedReductionHealthCacheWarmed() ?? false,
    protectedReductionHealthCacheStale:
      stores.coordinator?.isProtectedReductionHealthCacheStale() ?? true,
  };
}
