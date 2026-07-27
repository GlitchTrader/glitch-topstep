import assert from "node:assert/strict";
import { it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { MarketObservationState } from "../src/domain/market-observation.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot } from "./fixtures.js";

const NOW = Date.parse("2026-07-21T12:00:05Z");

const config: AppConfig = {
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

const recovery: ExecutionRecoveryStatus = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

it("changes packet identity with market evidence but never turns it into an execution gate", () => {
  const store = new SqliteExecutionStore(":memory:");
  let marketObservation: MarketObservationState = {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
  const service = new DecisionPacketService(
    config,
    snapshot,
    store,
    () => recovery,
    () => NOW,
    () => marketObservation,
  );
  try {
    const withoutBars = service.current();
    marketObservation = {
      last_attempt_utc: "2026-07-21T12:00:00Z",
      last_succeeded_utc: "2026-07-21T12:00:00Z",
      last_error: null,
      observation: {
        schema_version: "glitch.projectx.market_observation.v1",
        generated_utc: "2026-07-21T12:00:00Z",
        source: "projectx_bars",
        instrument: "MNQ",
        contract_id: "CON.F.US.MNQ.U26",
        timeframes: [],
      },
    };
    const withBars = service.current();
    marketObservation = {
      ...marketObservation,
      last_attempt_utc: "2026-07-21T12:01:00Z",
      last_error: "Error:history unavailable",
    };
    const degradedBars = service.current();

    assert.notEqual(withBars.market.snapshot_hash, withoutBars.market.snapshot_hash);
    assert.notEqual(degradedBars.market.snapshot_hash, withBars.market.snapshot_hash);
    assert.equal(withBars.execution.new_exposure_technically_supported, true);
    assert.equal(degradedBars.execution.new_exposure_technically_supported, true);
    assert.equal(degradedBars.market_observation.last_error, "Error:history unavailable");
  } finally {
    store.close();
  }
});
