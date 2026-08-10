import assert from "node:assert/strict";
import { it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { ProjectXOrderFlowState } from "../src/domain/order-flow.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";

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
  session: testSessionConfig,
  dailyEconomics: testDailyEconomicsConfig,
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
  entrySubmissionLatchStaleMs: 300_000,
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

it("changes packet identity with order flow but never turns flow into an execution gate", () => {
  const store = new SqliteExecutionStore(":memory:");
  let orderFlow: ProjectXOrderFlowState = {
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
    undefined,
    () => orderFlow,
  );
  try {
    const empty = service.current();
    orderFlow = {
      last_attempt_utc: "2026-07-21T12:00:00Z",
      last_succeeded_utc: "2026-07-21T12:00:00Z",
      last_error: null,
      observation: {
        schema_version: "glitch.projectx.order_flow.v1",
        generated_utc: "2026-07-21T12:00:00Z",
        source: "projectx_market_evidence",
        contract_id: "CON.F.US.MNQ.U26",
        lookback_start_utc: "2026-07-21T11:55:00Z",
        through_sequence: 10,
        events_read: 10,
        truncated: false,
        source_complete: true,
        invalid_events: 0,
        windows: [],
        depth: {
          depth_levels_requested: 10,
          available: true,
          unavailable_reason: null,
          reconstruction_basis: "bounded_window_without_reset",
          book_complete: false,
          latest_reset_sequence: null,
          best_bid: 20_000,
          best_ask: 20_000.25,
          spread_ticks: 1,
          bid_volume: 10,
          ask_volume: 8,
          imbalance_ratio: 2 / 18,
          bid_levels: [{ price: 20_000, current_volume: 10 }],
          ask_levels: [{ price: 20_000.25, current_volume: 8 }],
          depth_events_applied: 2,
          depth_events_ignored: 0,
          depth_events_invalid: 0,
        },
        issues: [],
        last_trade_utc: null,
      },
    };
    const observed = service.current();
    orderFlow = {
      ...orderFlow,
      last_attempt_utc: "2026-07-21T12:00:01Z",
      last_error: "Error:evidence database unavailable",
    };
    const degraded = service.current();

    assert.notEqual(observed.market.snapshot_hash, empty.market.snapshot_hash);
    assert.notEqual(degraded.market.snapshot_hash, observed.market.snapshot_hash);
    assert.equal(observed.execution.new_exposure_technically_supported, true);
    assert.equal(degraded.execution.new_exposure_technically_supported, true);
    assert.equal(degraded.order_flow.last_error, "Error:evidence database unavailable");

    orderFlow = {
      ...orderFlow,
      last_error: null,
      observation: {
        ...orderFlow.observation!,
        depth: {
          ...orderFlow.observation!.depth,
          available: false,
          best_bid: null,
          best_ask: null,
          bid_volume: 0,
          ask_volume: 0,
          bid_levels: [],
          ask_levels: [],
        },
      },
    };
    const depthMissing = service.current();
    assert.equal(depthMissing.data_quality.state_complete, true);
    assert.deepEqual(depthMissing.data_quality.issues, []);
    assert.deepEqual(depthMissing.data_quality.optional_issues, ["order_flow_depth_unavailable"]);
    assert.equal(depthMissing.execution.new_exposure_technically_supported, true);
    const stateGate = depthMissing.execution.gates.find((gate) => gate.id === "state_complete");
    assert.equal(stateGate?.passed, true);

    orderFlow = {
      ...orderFlow,
      observation: {
        ...orderFlow.observation!,
        depth: {
          ...orderFlow.observation!.depth,
          available: true,
          unavailable_reason: null,
          best_bid: 20_050,
          best_ask: 20_050.25,
          spread_ticks: 1,
          bid_volume: 10,
          ask_volume: 8,
          imbalance_ratio: 0.1,
          bid_levels: [{ price: 20_050, current_volume: 10 }],
          ask_levels: [{ price: 20_050.25, current_volume: 8 }],
        },
      },
    };
    const depthDiverged = service.current();
    assert.equal(depthDiverged.order_flow.observation?.depth.available, false);
    assert.equal(
      depthDiverged.order_flow.observation?.depth.unavailable_reason,
      "depth_bbo_diverges_from_quote",
    );
    assert.equal(depthDiverged.order_flow.observation?.depth.imbalance_ratio, null);
    assert.deepEqual(depthDiverged.data_quality.optional_issues, ["order_flow_depth_unavailable"]);
    assert.equal(depthDiverged.data_quality.state_complete, true);
    assert.equal(depthDiverged.execution.new_exposure_technically_supported, true);
  } finally {
    store.close();
  }
});
