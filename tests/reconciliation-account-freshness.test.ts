import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { AccountVenueSnapshot } from "../src/domain/models.js";
import { evaluateSnapshotDataQuality } from "../src/state/data-quality.js";
import { VenueStateStore } from "../src/state/venue-state.js";
import { runReconciliationCycle } from "../src/service/reconciliation-service.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot } from "./fixtures.js";

const emptyEnvelope = {
  success: true,
  errorCode: 0,
  errorMessage: null,
};

const settings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 15_000,
  maxIntentAgeMs: 300_000,
};

const RECONCILE_AT = "2026-09-08T14:41:41.335Z";
const SAMPLE_AT = "2026-09-08T14:41:45.000Z";
const OLD_ACCOUNT_AT = "2026-09-08T14:34:30.000Z";

function qualityAt(
  venueSnapshot: AccountVenueSnapshot,
  nowIso: string,
) {
  return evaluateSnapshotDataQuality(venueSnapshot, settings, new Date(nowIso));
}

function buildPeriodicReconcileSnapshot(reconcileAt: string): AccountVenueSnapshot {
  const state = new VenueStateStore();
  const base = snapshot();
  state.registerContracts([base.contract]);
  state.replaceAccounts([base.account], OLD_ACCOUNT_AT);
  state.applyAccount(base.account, reconcileAt);
  state.replacePositions([], reconcileAt);
  state.replaceOrders([], reconcileAt);
  state.applyQuote({ ...base.quote!, timestamp: reconcileAt }, reconcileAt);
  state.markStreamConnected("user", reconcileAt);
  state.markStreamConnected("market", reconcileAt);
  state.markStreamEvent("user", reconcileAt);
  state.markStreamEvent("market", reconcileAt);
  state.markReconciliationStarted(reconcileAt);
  state.markReconciliationSucceeded(reconcileAt);
  return state.buildSnapshot(base.account.id, base.contract.id);
}

function healthPacketFromVenue(venue: AccountVenueSnapshot) {
  const health = {
    status: "ok",
    recorded_utc: SAMPLE_AT,
    data_quality: {
      state_complete: venue.stateComplete,
      issues: [...venue.stateIssues],
      state_age_ms: null as number | null,
      quote_age_ms: 0,
    },
    execution_recovery: { blockingNewExposure: false },
    market_observation: {
      last_succeeded_utc: SAMPLE_AT,
      last_error: null,
    },
    read_circuit_breaker: { bars: { open: false } },
  };
  const packet = {
    data_quality: {
      state_complete: venue.stateComplete,
      issues: [...venue.stateIssues],
      state_age_ms: null as number | null,
      quote_age_ms: 0,
    },
    account: { instrument_open_contracts: venue.instrumentOpenContracts },
  };
  const q = qualityAt(venue, SAMPLE_AT);
  health.data_quality.state_age_ms = q.stateAgeMs;
  packet.data_quality.state_age_ms = q.stateAgeMs;
  health.data_quality.state_complete = q.stateComplete;
  packet.data_quality.state_complete = q.stateComplete;
  health.data_quality.issues = q.issues;
  packet.data_quality.issues = q.issues;
  return { health, packet };
}

describe("reconciliation account freshness", () => {
  it("negative: stale capturedAt with recent reconciliation success still marks account_state_stale", () => {
    const current = snapshot();
    current.capturedAt = OLD_ACCOUNT_AT;
    current.operational.reconciliation = {
      state: "succeeded",
      generation: 2,
      lastStartedAt: "2026-09-08T14:41:40.999Z",
      lastSucceededAt: RECONCILE_AT,
      lastError: null,
    };
    const quality = qualityAt(current, "2026-09-08T14:43:01.000Z");
    assert.ok(quality.issues.includes("account_state_stale"));
    assert.equal(quality.stateAgeMs, 511_000);
  });

  it("reconcile recent at 9s: account_state_stale=false", () => {
    const built = buildPeriodicReconcileSnapshot(RECONCILE_AT);
    const quality = qualityAt(built, "2026-09-08T14:41:50.335Z");
    assert.equal(quality.issues.includes("account_state_stale"), false);
    assert.equal(built.capturedAt, RECONCILE_AT);
    assert.equal(quality.stateAgeMs, 9_000);
  });

  it("reconcile exactly at 15s limit: account_state_stale=false", () => {
    const built = buildPeriodicReconcileSnapshot(RECONCILE_AT);
    const quality = qualityAt(built, "2026-09-08T14:41:56.335Z");
    assert.equal(quality.stateAgeMs, 15_000);
    assert.equal(quality.issues.includes("account_state_stale"), false);
  });

  it("reconcile just above 15s stays fresh while reconciliation grace applies", () => {
    const built = buildPeriodicReconcileSnapshot(RECONCILE_AT);
    const quality = qualityAt(built, "2026-09-08T14:41:56.336Z");
    assert.equal(quality.stateAgeMs, 15_001);
    assert.equal(quality.issues.includes("account_state_stale"), false);
  });

  it("reconcile above 15s after grace expires: account_state_stale=true", () => {
    const built = buildPeriodicReconcileSnapshot(RECONCILE_AT);
    const quality = qualityAt(built, "2026-09-08T14:42:12.336Z");
    assert.equal(quality.stateAgeMs, 31_001);
    assert.ok(quality.issues.includes("account_state_stale"));
  });

  it("rejects materially future capturedAt timestamp", () => {
    const current = snapshot();
    current.capturedAt = "2026-09-08T14:42:00.000Z";
    const quality = qualityAt(current, "2026-09-08T14:41:50.000Z");
    assert.ok(quality.issues.includes("account_state_timestamp_future"));
  });

  it("health and packet coherent after periodic reconcile bump", () => {
    const built = buildPeriodicReconcileSnapshot(RECONCILE_AT);
    const { health, packet } = healthPacketFromVenue(built);
    assert.equal(health.data_quality.state_complete, packet.data_quality.state_complete);
    assert.equal(health.data_quality.state_age_ms, packet.data_quality.state_age_ms);
    assert.deepEqual(health.data_quality.issues, packet.data_quality.issues);
    assert.equal(health.data_quality.state_complete, true);
  });

  it("health/packet divergent when only health is stale", () => {
    const fresh = buildPeriodicReconcileSnapshot(RECONCILE_AT);
    const stale = snapshot();
    stale.capturedAt = OLD_ACCOUNT_AT;
    const staleQ = qualityAt(stale, "2026-09-08T14:43:01.000Z");
    const { health, packet } = healthPacketFromVenue(fresh);
    health.data_quality.state_complete = staleQ.stateComplete;
    health.data_quality.issues = staleQ.issues;
    health.data_quality.state_age_ms = staleQ.stateAgeMs;
    assert.notEqual(health.data_quality.state_complete, packet.data_quality.state_complete);
    assert.ok(health.data_quality.issues.includes("account_state_stale"));
    assert.equal(packet.data_quality.issues.includes("account_state_stale"), false);
  });

  it("reconnect during reconcile: grace does not mask stale capturedAt", () => {
    const current = snapshot();
    current.capturedAt = OLD_ACCOUNT_AT;
    current.operational.generation = 3;
    current.operational.reconciliation = {
      state: "succeeded",
      generation: 2,
      lastStartedAt: RECONCILE_AT,
      lastSucceededAt: RECONCILE_AT,
      lastError: null,
    };
    const quality = qualityAt(current, "2026-09-08T14:41:50.000Z");
    assert.ok(quality.issues.includes("account_state_stale"));
  });
});

describe("runReconciliationCycle periodic path", () => {
  it("includeMetadata false calls applyAccount and keeps capturedAt fresh", async () => {
    const base = snapshot();
    const state = new VenueStateStore();
    const executionStore = new SqliteExecutionStore(":memory:");
    state.registerContracts([base.contract]);
    state.replaceAccounts([base.account], OLD_ACCOUNT_AT);
    state.replacePositions([], OLD_ACCOUNT_AT);
    state.replaceOrders([], OLD_ACCOUNT_AT);
    state.applyQuote(base.quote!, OLD_ACCOUNT_AT);

    const fixedNow = new Date(RECONCILE_AT);
    mock.timers.enable({ apis: ["Date"], now: fixedNow });

    try {
      await runReconciliationCycle(
        {
          scope: {
            accountId: base.account.id,
            accountName: base.account.name,
            contractId: base.contract.id,
            instrument: "MNQ",
          },
          api: {
            searchOpenPositionsCollection: async () => ({ items: [], envelope: emptyEnvelope }),
            searchOpenOrdersCollection: async () => ({ items: [], envelope: emptyEnvelope }),
          } as never,
          state,
          executionStore,
          ledger: { append: async () => {} } as never,
          coordinator: null,
          lastReconciledOpenContracts: 0,
          setLastReconciledOpenContracts: () => {},
          resolveClosedTranchesForFlat: () => [],
          recordRestSnapshot: () => {},
          publishTradeOutcomesOnFlat: async () => {},
          refreshCachedOpenTranches: () => {},
          clearCachedOpenTranches: () => {},
          observeTradeExcursion: () => {},
          retryIncompleteTradeOutcomes: async () => {},
          reconcileEntrySubmissionLatch: () => false,
          persistRecoveryResolutions: async () => {},
          invalidateIssuedPackets: () => {},
        },
        { includeMetadata: false },
      );
    } finally {
      mock.timers.reset();
    }

    const built = state.buildSnapshot(base.account.id, base.contract.id);
    const quality = qualityAt(built, "2026-09-08T14:41:50.335Z");
    assert.equal(built.capturedAt, RECONCILE_AT);
    assert.equal(quality.issues.includes("account_state_stale"), false);
  });
});
