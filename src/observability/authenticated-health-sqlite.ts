import type { DurableControlStore } from "../control/durable-control-store.js";
import type { ProtectedReductionHealth } from "../execution/protected-reduction-saga.js";
import type { AccountVenueSnapshot } from "../domain/models.js";
import type { ProviderEvidenceStatus } from "../domain/provider-evidence.js";
import type { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { SqliteProviderEvidenceStore } from "../storage/sqlite-provider-evidence-store.js";
import type { TradeOutcomeStore } from "../storage/trade-outcome-store.js";
import type { MayPromise } from "../storage/may-promise.js";

/**
 * Single choke point for SQLite touched by authenticated /health.
 * Reconcile heats; /health only peeks — any new health SQLite field must land here
 * so tests/authenticated-health-sqlite-isolation.test.ts fails before production stalls.
 */

export interface ProtectedReductionHealthCache {
  refreshProtectedReductionHealthCache(
    snapshot: AccountVenueSnapshot,
  ): ProtectedReductionHealth | Promise<ProtectedReductionHealth>;
  peekProtectedReductionHealth(): ProtectedReductionHealth | null;
  isProtectedReductionHealthCacheStale(): boolean;
  isProtectedReductionHealthCacheWarmed(): boolean;
}

export interface AuthenticatedHealthSqliteStores {
  executionStore: MayPromise<SqliteExecutionStore>;
  controlStore: MayPromise<DurableControlStore>;
  tradeOutcomeStore: TradeOutcomeStore;
  providerEvidenceStore: MayPromise<SqliteProviderEvidenceStore>;
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
export async function refreshAuthenticatedHealthSqliteCaches(
  stores: AuthenticatedHealthSqliteStores,
  snapshot: AccountVenueSnapshot,
): Promise<ProtectedReductionHealth | null> {
  const protectedReduction = await stores.coordinator?.refreshProtectedReductionHealthCache(snapshot)
    ?? null;
  await stores.executionStore.recoveryStatus();
  await stores.executionStore.refreshExecutionFactsHealthCache();
  await stores.controlStore.refreshHealthCache();
  await stores.tradeOutcomeStore.refreshHealthCache();
  await stores.providerEvidenceStore.refreshHealthCache();
  return protectedReduction;
}

/** Authenticated /health SQLite slice — must never call DatabaseSync.prepare. */
export function peekAuthenticatedHealthSqlite(
  stores: AuthenticatedHealthSqliteStores,
  nowMs = Date.now(),
): AuthenticatedHealthSqliteFields {
  const protectedPeek = settled(stores.coordinator?.peekProtectedReductionHealth() ?? null);
  const factsPeek = settled(stores.executionStore.peekExecutionFactsStatus());
  return {
    recoveryPeek: settled(stores.executionStore.peekRecoveryStatus()),
    recoveryCacheStale: settled(stores.executionStore.isRecoveryCacheStale()),
    unprotectedSinceUtc: settled(stores.executionStore.peekUnprotectedSinceUtc()),
    unprotectedSinceCacheStale: settled(stores.executionStore.isUnprotectedSinceCacheStale()),
    controlCounts: settled(stores.controlStore.peekStatus()),
    flattenPending: settled(stores.controlStore.peekHasPendingFlatten()),
    flattenPendingAgeMs: settled(stores.controlStore.peekOldestPendingFlattenAgeMs(nowMs)),
    controlHealthCacheWarmed: settled(stores.controlStore.isHealthCacheWarmed()),
    controlHealthCacheStale: settled(stores.controlStore.isHealthCacheStale()),
    outcomeFeed: settled(stores.tradeOutcomeStore.peekStatus()),
    outcomeHealthCacheWarmed: settled(stores.tradeOutcomeStore.isHealthCacheWarmed()),
    outcomeHealthCacheStale: settled(stores.tradeOutcomeStore.isHealthCacheStale()),
    providerEvidence: settled(stores.providerEvidenceStore.peekStatus()),
    providerEvidenceHealthCacheWarmed: settled(stores.providerEvidenceStore.isHealthCacheWarmed()),
    providerEvidenceHealthCacheStale: settled(stores.providerEvidenceStore.isHealthCacheStale()),
    executionFacts: factsPeek ?? UNHEATED_EXECUTION_FACTS,
    executionFactsCacheWarmed: settled(stores.executionStore.isExecutionFactsCacheWarmed()),
    executionFactsCacheStale: settled(stores.executionStore.isExecutionFactsCacheStale()),
    protectedReduction: protectedPeek ?? UNHEATED_PROTECTED_REDUCTION,
    protectedReductionHealthCacheWarmed:
      stores.coordinator?.isProtectedReductionHealthCacheWarmed() ?? false,
    protectedReductionHealthCacheStale:
      stores.coordinator?.isProtectedReductionHealthCacheStale() ?? true,
  };
}

function settled<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) {
    throw new Error("health_peek_must_not_wait_on_sqlite");
  }
  return value;
}
