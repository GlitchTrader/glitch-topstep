import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot } from "./fixtures.js";

const CURRENT_TIME_MS = Date.parse("2026-07-21T12:00:05Z");

function config(): AppConfig {
  return {
    projectX: {
      username: "user",
      apiKey: "key",
      apiUrl: "https://api.topstepx.com",
      userHubUrl: "https://rtc.topstepx.com/hubs/user",
      marketHubUrl: "https://rtc.topstepx.com/hubs/market",
    },
    scope: {
      accountId: 101,
      accountName: "TEST_ACCOUNT",
      contractId: "CON.F.US.MNQ.U26",
      instrument: "MNQ",
      liveMarketData: false,
    },
    localGateway: {
      host: "127.0.0.1",
      port: 8790,
      token: "012345678901234567890123",
    },
    tradingMode: "shadow",
    policy: {
      accountStage: "express_funded_standard",
      lossModel: "express_funded_eod",
      authority: "operator_configured",
      verifiedAtUtc: null,
      startingBalance: 50_000,
      initialMaximumLoss: 2_000,
      highestEndOfDayBalance: 0,
      lossFloorLockedAtZero: false,
      payoutProcessed: false,
      operatorProvidedLossFloorUsd: null,
      maxContracts: 5,
    },
    risk: {
      estimatedRoundTurnFeesUsd: 2.5,
      slippageReserveTicks: 2,
      maxQuoteAgeMs: 5_000,
      maxStateAgeMs: 5_000,
      maxIntentAgeMs: 300_000,
    },
    providerEvidence: {
      marketEventRetention: 500_000,
      marketPruneInterval: 10_000,
    },
    dataDir: "./data",
    reconcileIntervalMs: 3_000,
    packetLeaseMs: 300_000,
  };
}

function healthyRecovery(): ExecutionRecoveryStatus {
  return {
    blockingAmbiguity: false,
    entrySubmissionPending: false,
    blockingNewExposure: false,
    unresolvedMutations: 0,
    ambiguousMutations: 0,
    lastRecoveryUtc: null,
    lastRecoveryError: null,
  };
}

describe("decision packet issuance", () => {
  it("publishes current truth while preserving an issued decision lease", () => {
    let now = CURRENT_TIME_MS;
    const current = snapshot();
    const store = new SqliteExecutionStore(":memory:");
    const service = new DecisionPacketService(config(), () => current, store, healthyRecovery, () => now);
    const first = service.current();
    assert.equal(first.schema_version, "glitch.direct.decision_packet.v2");
    assert.equal(first.required_output_template.operator_profile, "glitch-topstep");
    assert.equal(first.data_quality.state_complete, true);
    assert.equal(first.data_quality.quote_age_ms, 1_000);
    current.quote = { ...current.quote!, bestAsk: 20_001.25, timestamp: "2026-07-21T12:00:05Z" };
    const second = service.current();
    assert.notEqual(second.market.snapshot_hash, first.market.snapshot_hash);
    assert.ok(service.resolve(first.market.snapshot_hash));
    now += 300_001;
    assert.equal(service.resolve(first.market.snapshot_hash), null);
    store.close();
  });

  it("changes factual quality when unchanged state crosses the stale boundary", () => {
    let now = CURRENT_TIME_MS;
    const store = new SqliteExecutionStore(":memory:");
    const service = new DecisionPacketService(config(), snapshot, store, healthyRecovery, () => now);
    const fresh = service.current();
    now += 5_001;
    const stale = service.current();
    assert.equal(fresh.data_quality.state_complete, true);
    assert.equal(stale.data_quality.state_complete, false);
    assert.ok(stale.data_quality.issues.includes("quote_stale"));
    assert.ok(stale.data_quality.issues.includes("account_state_stale"));
    assert.equal(stale.execution.new_exposure_technically_supported, false);
    assert.notEqual(stale.market.snapshot_hash, fresh.market.snapshot_hash);
    store.close();
  });

  it("invalidates every issued decision after venue truth is invalidated", () => {
    const store = new SqliteExecutionStore(":memory:");
    const service = new DecisionPacketService(
      config(),
      snapshot,
      store,
      healthyRecovery,
      () => CURRENT_TIME_MS,
    );
    const issued = service.current();
    service.invalidateAll();
    assert.equal(service.resolve(issued.market.snapshot_hash), null);
    store.close();
  });

  it("publishes recovery ambiguity as evidence and capability state", () => {
    const store = new SqliteExecutionStore(":memory:");
    const recovery = (): ExecutionRecoveryStatus => ({
      blockingAmbiguity: true,
      entrySubmissionPending: true,
      blockingNewExposure: true,
      unresolvedMutations: 1,
      ambiguousMutations: 1,
      lastRecoveryUtc: null,
      lastRecoveryError: "provider_order_not_found",
    });
    const packet = new DecisionPacketService(
      config(),
      snapshot,
      store,
      recovery,
      () => CURRENT_TIME_MS,
    ).current();
    assert.equal(packet.execution.recovery_blocked, true);
    assert.equal(packet.execution.entry_submission_pending, true);
    assert.equal(packet.execution.new_exposure_technically_supported, false);
    assert.equal(packet.execution.ambiguous_mutations, 1);
    store.close();
  });

  it("publishes a pending accepted entry as a factual capability block", () => {
    const store = new SqliteExecutionStore(":memory:");
    const recovery = (): ExecutionRecoveryStatus => ({
      ...healthyRecovery(),
      entrySubmissionPending: true,
      blockingNewExposure: true,
    });
    const packet = new DecisionPacketService(
      config(),
      snapshot,
      store,
      recovery,
      () => CURRENT_TIME_MS,
    ).current();
    assert.equal(packet.execution.entry_submission_pending, true);
    assert.equal(packet.execution.recovery_blocked, true);
    assert.equal(packet.execution.new_exposure_technically_supported, false);
    store.close();
  });
});
