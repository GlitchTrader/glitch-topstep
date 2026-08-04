import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import {
  buildExecutionGates,
  gatewayModePermitsLiveOrders,
  resolveGatewayMode,
} from "../src/execution/gateway-mode.js";
import { snapshot, orderFlowWithTrades, testSessionConfig } from "./fixtures.js";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";

function config(tradingMode: AppConfig["tradingMode"]): AppConfig {
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
    tradingMode,
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

describe("armed runtime gate", () => {
  it("keeps configured armed mode when the 60s tape is quiet", () => {
    const current = snapshot();
    const now = new Date("2026-07-21T12:00:05Z");
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: now.toISOString() };
    const resolved = resolveGatewayMode(
      "armed",
      current,
      config("armed").risk,
      orderFlowWithTrades(0),
      now,
    );
    assert.equal(resolved.effective, "armed");
    assert.equal(resolved.downgradeReason, null);
  });

  it("exposes effective gateway mode on decision packets", () => {
    const current = snapshot();
    const now = new Date("2026-07-21T12:00:05Z");
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: now.toISOString() };
    const appConfig = config("armed");
    const packet = buildDecisionPacket(
      current,
      appConfig.policy,
      appConfig.risk,
      healthyRecovery(),
      appConfig.scope.instrument,
      appConfig.tradingMode,
      appConfig.packetLeaseMs,
      now,
      undefined,
      orderFlowWithTrades(3),
    );
    assert.equal(packet.execution.gateway_mode_configured, "armed");
    assert.equal(packet.execution.gateway_mode, "armed");
    assert.equal(packet.execution.gateway_mode_downgrade_reason, null);
  });

  it("exposes structured execution gates on decision packets", () => {
    const current = snapshot();
    const now = new Date("2026-07-21T12:00:05Z");
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: now.toISOString() };
    const appConfig = config("armed");
    const packet = buildDecisionPacket(
      current,
      appConfig.policy,
      appConfig.risk,
      healthyRecovery(),
      appConfig.scope.instrument,
      appConfig.tradingMode,
      appConfig.packetLeaseMs,
      now,
      undefined,
      orderFlowWithTrades(3),
    );
    const gateIds = packet.execution.gates.map((gate) => gate.id);
    assert.deepEqual(gateIds, [
      "state_complete",
      "quote_stale",
      "reconciliation_current",
      "risk_reduction_technically_supported",
      "new_exposure_technically_supported",
    ]);
    assert.ok(packet.execution.gates.every((gate) => gate.passed));
    assert.equal(packet.execution.new_exposure_technically_supported, true);
  });

  it("keeps quiet-tape measurements in the packet without converting them into a gate", () => {
    const current = snapshot();
    const now = new Date("2026-07-21T12:00:05Z");
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: now.toISOString() };
    const appConfig = config("armed");
    const packet = buildDecisionPacket(
      current,
      appConfig.policy,
      appConfig.risk,
      healthyRecovery(),
      appConfig.scope.instrument,
      appConfig.tradingMode,
      appConfig.packetLeaseMs,
      now,
      undefined,
      orderFlowWithTrades(0),
    );
    const tape60 = packet.order_flow.observation?.windows.find(
      (window) => window.window_seconds === 60,
    );
    assert.equal(tape60?.trade_count, 0);
    assert.equal(packet.execution.gateway_mode, "armed");
    assert.equal(
      packet.execution.gates.some((gate) => gate.id === "order_flow_trades_60s"),
      false,
    );
  });

  it("keeps EXIT permitted under degraded_armed while new exposure is suppressed", () => {
    const current = snapshot();
    const now = new Date("2026-07-21T12:00:10Z");
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: "2026-07-21T12:00:00Z" };
    current.instrumentOpenContracts = 1;
    current.totalOpenContracts = 1;
    current.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      type: 1,
      size: 1,
      averagePrice: 20_000,
    }];
    current.openOrders = [{
      id: 9201,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 4,
      side: 1,
      size: 1,
      limitPrice: null,
      stopPrice: 19_990,
      customTag: "glt-00000000-0000-4000-8000-00000000a001-SL",
    }];
    const appConfig = config("armed");
    const packet = buildDecisionPacket(
      current,
      appConfig.policy,
      appConfig.risk,
      healthyRecovery(),
      appConfig.scope.instrument,
      appConfig.tradingMode,
      appConfig.packetLeaseMs,
      now,
      undefined,
      orderFlowWithTrades(0),
    );
    assert.equal(packet.execution.gateway_mode, "degraded_armed");
    assert.match(packet.execution.gateway_mode_downgrade_reason ?? "", /quote_stale/);
    const riskGate = packet.execution.gates.find(
      (gate) => gate.id === "risk_reduction_technically_supported",
    );
    assert.equal(riskGate?.passed, true);
    assert.ok(packet.execution.supported_actions.includes("EXIT"));
    assert.equal(gatewayModePermitsLiveOrders(packet.execution.gateway_mode), false);
  });
});

describe("buildExecutionGates", () => {
  it("reports quote_stale with quote_age_ms detail", () => {
    const current = snapshot();
    const now = new Date("2026-07-21T12:00:10Z");
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: "2026-07-21T12:00:00Z" };
    const appConfig = config("armed");
    const gates = buildExecutionGates(
      current,
      appConfig.risk,
      orderFlowWithTrades(2),
      healthyRecovery(),
      appConfig.tradingMode,
      appConfig.policy.maxContracts,
      now,
    );
    const quoteGate = gates.find((gate) => gate.id === "quote_stale");
    assert.equal(quoteGate?.passed, false);
    assert.match(quoteGate?.detail ?? "", /quote_age_ms=10000 max=5000/);
  });

  it("reports new_exposure sub-reasons when blocked", () => {
    const current = snapshot();
    current.openOrders = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      type: 1,
      side: 0,
      size: 1,
      limitPrice: 20_000,
      stopPrice: null,
      status: 1,
      creationTimestamp: "2026-07-21T12:00:00Z",
      updateTimestamp: "2026-07-21T12:00:00Z",
    }];
    const appConfig = config("shadow");
    const gates = buildExecutionGates(
      current,
      appConfig.risk,
      orderFlowWithTrades(2),
      healthyRecovery(),
      appConfig.tradingMode,
      appConfig.policy.maxContracts,
      new Date("2026-07-21T12:00:05Z"),
    );
    const exposureGate = gates.find((gate) => gate.id === "new_exposure_technically_supported");
    assert.equal(exposureGate?.passed, false);
    assert.match(exposureGate?.detail ?? "", /no_open_orders/);
  });

  it("passes new_exposure for valid same-direction scale-in", () => {
    const current = snapshot();
    current.instrumentOpenContracts = 1;
    current.totalOpenContracts = 1;
    current.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      type: 2,
      size: 1,
      averagePrice: 20_000,
    }];
    current.openOrders = [{
      id: 9201,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 4,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: 20_010,
      customTag: "glt-00000000-0000-4000-8000-00000000a001-SL",
    }];
    const appConfig = config("armed");
    const gates = buildExecutionGates(
      current,
      appConfig.risk,
      orderFlowWithTrades(2),
      healthyRecovery(),
      appConfig.tradingMode,
      appConfig.policy.maxContracts,
      new Date("2026-07-21T12:00:05Z"),
    );
    const exposureGate = gates.find((gate) => gate.id === "new_exposure_technically_supported");
    assert.equal(exposureGate?.passed, true);
  });

  it("reports scale_in_blocked when positioned but scale-in is invalid", () => {
    const current = snapshot();
    current.instrumentOpenContracts = 1;
    current.totalOpenContracts = 1;
    current.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      type: 1,
      size: 1,
      averagePrice: 20_000,
    }];
    current.openOrders = [{
      id: 9301,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 2,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: null,
      customTag: "glt-pending-entry",
    }];
    const appConfig = config("armed");
    const gates = buildExecutionGates(
      current,
      appConfig.risk,
      orderFlowWithTrades(2),
      healthyRecovery(),
      appConfig.tradingMode,
      appConfig.policy.maxContracts,
      new Date("2026-07-21T12:00:05Z"),
    );
    const exposureGate = gates.find((gate) => gate.id === "new_exposure_technically_supported");
    assert.equal(exposureGate?.passed, false);
    assert.match(exposureGate?.detail ?? "", /scale_in_blocked/);
  });
});
