import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { OrderInfo } from "../src/domain/models.js";
import { ExecutionCoordinator } from "../src/execution/coordinator.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import type { ModifyOrderRequest, ProjectXApiClient } from "../src/projectx/client.js";
import { JsonlEventStore } from "../src/storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { orderFlowWithTrades, snapshot } from "./fixtures.js";

const INTENT_ID = "00000000-0000-4000-8000-00000000b001";
const ENTRY_INTENT_ID = "00000000-0000-4000-8000-00000000b000";

function config(dataDir: string): AppConfig {
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
    dataDir,
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

function audit(action: string) {
  return {
    bull_case: "Bull case.",
    bear_case: "Bear case.",
    flat_case: "Flat case.",
    aggressive_case: "Aggressive case.",
    conservative_case: "Conservative case.",
    decisive_evidence: "Evidence.",
    disconfirming_evidence: "Counter evidence.",
    change_condition: "Change condition.",
    final_choice: action,
  };
}

function protectiveOrders(intentId: string): OrderInfo[] {
  return [
    {
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
      customTag: `glt-${intentId}-SL`,
    },
    {
      id: 9202,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 1,
      side: 1,
      size: 1,
      limitPrice: 20_020,
      stopPrice: null,
      customTag: `glt-${intentId}-TP`,
    },
  ];
}

function openPositionSnapshot(intentId: string) {
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
  current.openOrders = protectiveOrders(intentId);
  return current;
}

describe("position management coordinator", () => {
  it("submits MOVE_STOP against the proven stop child and returns a pending receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-move-stop-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = openPositionSnapshot(ENTRY_INTENT_ID);
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
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
      store.recordIssuedPacket(packet);
      let modified: ModifyOrderRequest | undefined;
      const api = {
        placeOrder: async () => 9001,
        modifyOrder: async (request: ModifyOrderRequest) => {
          modified = request;
        },
        closePosition: async () => undefined,
      } as unknown as ProjectXApiClient;
      const coordinator = new ExecutionCoordinator(
        appConfig,
        api,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: INTENT_ID,
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "MOVE_STOP",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Raise stop to breakeven.",
        decision_audit: audit("MOVE_STOP"),
        new_stop_price: 20_000,
      });
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "move_stop_submitted_pending_reconciliation");
      assert.equal(modified?.orderId, 9201);
      assert.equal(modified?.stopPrice, 20_000);
      assert.equal(packet.execution.supported_actions.includes("MOVE_STOP"), true);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays the same MOVE_STOP intent idempotently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-idempotent-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = openPositionSnapshot(ENTRY_INTENT_ID);
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
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
      store.recordIssuedPacket(packet);
      let modifyCalls = 0;
      const api = {
        placeOrder: async () => 9001,
        modifyOrder: async () => {
          modifyCalls += 1;
        },
        closePosition: async () => undefined,
      } as unknown as ProjectXApiClient;
      const coordinator = new ExecutionCoordinator(
        appConfig,
        api,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const wireIntent = {
        schema_version: "glitch.intent.v2",
        intent_id: INTENT_ID,
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "MOVE_STOP",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Raise stop to breakeven.",
        decision_audit: audit("MOVE_STOP"),
        new_stop_price: 20_000,
      };
      const [first, second] = await Promise.all([
        coordinator.handleWireIntent(wireIntent),
        coordinator.handleWireIntent(wireIntent),
      ]);
      assert.equal(modifyCalls, 1);
      assert.equal(first.receipt_id, second.receipt_id);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("submits partial EXIT as an opposite-side market order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-partial-exit-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = openPositionSnapshot(ENTRY_INTENT_ID);
      current.positions[0]!.size = 2;
      current.instrumentOpenContracts = 2;
      current.totalOpenContracts = 2;
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
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
      store.recordIssuedPacket(packet);
      let placedSize: number | undefined;
      const api = {
        placeOrder: async (request: { size: number }) => {
          placedSize = request.size;
          return 9301;
        },
        modifyOrder: async () => undefined,
        closePosition: async () => {
          throw new Error("closePosition should not be called for partial exit");
        },
      } as unknown as ProjectXApiClient;
      const coordinator = new ExecutionCoordinator(
        appConfig,
        api,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b002",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Bank one contract.",
        decision_audit: audit("EXIT"),
        quantity: 1,
      });
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "partial_exit_submitted_pending_reconciliation");
      assert.equal(placedSize, 1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
