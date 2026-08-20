import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { evaluateSafetySupervisor } from "../src/safety/safety-supervisor.js";
import { snapshot, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";
import type { AppConfig } from "../src/config.js";

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
    tradingMode: "armed",
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
      maxContracts: 3,
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
}

const healthyRecovery = (): ExecutionRecoveryStatus => ({
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
});

test("TS-AUDIT-12 safety supervisor starts in observe mode and blocks unprotected exposure", () => {
  const venue = snapshot();
  const evaluation = evaluateSafetySupervisor({
    snapshot: venue,
    risk: config().risk,
    tradingMode: "armed",
    runtimeTradingMode: "armed",
    operatorPaused: false,
    recovery: healthyRecovery(),
    maxContracts: 3,
    auth: {
      degraded: false,
      lastRefreshUtc: new Date().toISOString(),
      expiresAtUtc: null,
      refreshInFlight: false,
      refreshFailureCount: 0,
    },
    protectedReduction: {
      active_state: null,
      active_reduction_id: null,
      unprotected_open_quantity: 1,
      orphan_protective_orders: 0,
      ambiguous_age_ms: 4_000,
      fail_closed_rollback: false,
    },
    flattenPending: false,
  });
  assert.equal(evaluation.mode, "observe");
  assert.equal(evaluation.would_block_new_exposure, true);
  const protection = evaluation.invariants.find((entry) => entry.id === "protection_coverage");
  assert.ok(protection && !protection.ok);
});

test("TS-AUDIT-12 safety supervisor agrees with execution gates on healthy armed snapshot", () => {
  const venue = snapshot();
  const evaluation = evaluateSafetySupervisor({
    snapshot: venue,
    risk: config().risk,
    tradingMode: "armed",
    runtimeTradingMode: "armed",
    operatorPaused: false,
    recovery: healthyRecovery(),
    maxContracts: 3,
    auth: {
      degraded: false,
      lastRefreshUtc: new Date().toISOString(),
      expiresAtUtc: null,
      refreshInFlight: false,
      refreshFailureCount: 0,
    },
    protectedReduction: {
      active_state: null,
      active_reduction_id: null,
      unprotected_open_quantity: 0,
      orphan_protective_orders: 0,
      ambiguous_age_ms: null,
      fail_closed_rollback: false,
    },
    flattenPending: false,
  });
  assert.equal(evaluation.agrees_with_execution_gates, true);
  assert.equal(evaluation.risk_reduction_permitted, true);
});
