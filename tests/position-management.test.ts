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
import type { TrancheView } from "../src/ownership/tranches.js";
import type { ModifyOrderRequest, ProjectXApiClient } from "../src/projectx/client.js";
import { JsonlEventStore } from "../src/storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { orderFlowWithTrades, snapshot } from "./fixtures.js";

const INTENT_ID = "00000000-0000-4000-8000-00000000b001";
const ENTRY_INTENT_ID = "00000000-0000-4000-8000-00000000b000";
const ENTRY_INTENT_ID_B = "00000000-0000-4000-8000-00000000b003";

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

function tranche(intentId: string, remainingQty: number, entryOrderId: number): TrancheView {
  return {
    intent_id: intentId,
    entry_order_id: entryOrderId,
    filled_qty: remainingQty,
    remaining_qty: remainingQty,
    created_utc: "2026-07-21T12:00:05Z",
    protection: {
      status: "proven",
      reason: "provider_child_orders_bound_by_custom_tag",
      stop: {
        provider_order_id: entryOrderId + 10,
        custom_tag: `glt-${intentId}-SL`,
        price: 19_990,
      },
      target: {
        provider_order_id: entryOrderId + 11,
        custom_tag: `glt-${intentId}-TP`,
        price: 20_020,
      },
    },
  };
}

describe("position management coordinator", () => {
  it("submits MOVE_STOP against a targeted tranche protection leg", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-targeted-move-stop-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = openPositionSnapshot(ENTRY_INTENT_ID);
      current.positions[0]!.size = 2;
      current.instrumentOpenContracts = 2;
      current.totalOpenContracts = 2;
      current.openOrders = [
        ...protectiveOrders(ENTRY_INTENT_ID),
        ...protectiveOrders(ENTRY_INTENT_ID_B),
      ];
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
        [
          tranche(ENTRY_INTENT_ID, 1, 9001),
          tranche(ENTRY_INTENT_ID_B, 1, 9002),
        ],
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
        () => [
          tranche(ENTRY_INTENT_ID, 1, 9001),
          tranche(ENTRY_INTENT_ID_B, 1, 9002),
        ],
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b006",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "MOVE_STOP",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Tighten tranche B stop.",
        decision_audit: audit("MOVE_STOP"),
        new_stop_price: 20_005,
        target_intent_id: ENTRY_INTENT_ID_B,
      });
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "move_stop_submitted_pending_reconciliation");
      assert.equal(modified?.orderId, 9201);
      assert.equal(modified?.stopPrice, 20_005);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers live open-order protection ids over stale tranche cache after partial exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-stale-protection-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = openPositionSnapshot(ENTRY_INTENT_ID);
      const refreshedStopId = 9401;
      const refreshedTargetId = 9402;
      current.openOrders = [
        {
          ...protectiveOrders(ENTRY_INTENT_ID)[0]!,
          id: refreshedStopId,
        },
        {
          ...protectiveOrders(ENTRY_INTENT_ID)[1]!,
          id: refreshedTargetId,
        },
      ];
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
        [tranche(ENTRY_INTENT_ID, 1, 9001)],
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
        () => [tranche(ENTRY_INTENT_ID, 1, 9001)],
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b008",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "MOVE_TP",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Refresh target after partial exit.",
        decision_audit: audit("MOVE_TP"),
        new_take_profit: 20_030,
        target_intent_id: ENTRY_INTENT_ID,
      });
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "move_tp_submitted_pending_reconciliation");
      assert.equal(modified?.orderId, refreshedTargetId);
      assert.equal(modified?.limitPrice, 20_030);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects MOVE_STOP without target_intent_id when multiple tranches are active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-move-stop-target-required-"));
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
        [
          tranche(ENTRY_INTENT_ID, 1, 9001),
          tranche(ENTRY_INTENT_ID_B, 1, 9002),
        ],
      );
      store.recordIssuedPacket(packet);
      const api = {
        placeOrder: async () => 9001,
        modifyOrder: async () => undefined,
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
        () => [
          tranche(ENTRY_INTENT_ID, 1, 9001),
          tranche(ENTRY_INTENT_ID_B, 1, 9002),
        ],
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b007",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "MOVE_STOP",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Ambiguous tranche.",
        decision_audit: audit("MOVE_STOP"),
        new_stop_price: 20_005,
      });
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.code, "target_intent_id_required");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("submits targeted partial EXIT against a specific tranche remaining quantity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-targeted-exit-"));
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
          return 9302;
        },
        modifyOrder: async () => undefined,
        closePosition: async () => {
          throw new Error("closePosition should not be called for targeted partial exit");
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
        () => [
          tranche(ENTRY_INTENT_ID, 1, 9001),
          tranche(ENTRY_INTENT_ID_B, 1, 9002),
        ],
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b004",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Exit the second tranche only.",
        decision_audit: audit("EXIT"),
        quantity: 1,
        target_intent_id: ENTRY_INTENT_ID_B,
      });
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "partial_exit_submitted_pending_reconciliation");
      assert.equal(placedSize, 1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("submits partial targeted EXIT when venue reports multiple single-lot positions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-split-positions-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = openPositionSnapshot(ENTRY_INTENT_ID);
      const basePosition = current.positions[0]!;
      current.positions = [
        { ...basePosition, size: -1 },
        { ...basePosition, id: basePosition.id + 1, size: -1 },
      ];
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
      let closeCalled = false;
      const api = {
        placeOrder: async (request: { size: number }) => {
          placedSize = request.size;
          return 9303;
        },
        modifyOrder: async () => undefined,
        closePosition: async () => {
          closeCalled = true;
          return undefined;
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
        () => [
          tranche(ENTRY_INTENT_ID, 1, 9001),
          tranche(ENTRY_INTENT_ID_B, 1, 9002),
        ],
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b005",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Exit the second tranche only with split venue rows.",
        decision_audit: audit("EXIT"),
        quantity: 1,
        target_intent_id: ENTRY_INTENT_ID_B,
      });
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "partial_exit_submitted_pending_reconciliation");
      assert.equal(placedSize, 1);
      assert.equal(closeCalled, false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects targeted EXIT when quantity exceeds tranche remaining", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-targeted-exit-reject-"));
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
      const api = {
        placeOrder: async () => {
          throw new Error("placeOrder should not be called");
        },
        modifyOrder: async () => undefined,
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
        () => [tranche(ENTRY_INTENT_ID_B, 1, 9002)],
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-00000000b005",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Too large for tranche.",
        decision_audit: audit("EXIT"),
        quantity: 2,
        target_intent_id: ENTRY_INTENT_ID_B,
      });
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.code, "exit_quantity_exceeds_tranche_remaining");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns closed when reconciliation already marked EXIT submitted during closePosition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-pm-exit-race-"));
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
      const exitIntentId = "00000000-0000-4000-8000-00000000b004";
      const api = {
        placeOrder: async () => 9001,
        modifyOrder: async () => undefined,
        closePosition: async () => {
          const mutation = store.mutationForIntent(exitIntentId);
          if (mutation?.state === "submitting") {
            store.markMutationSubmitted(exitIntentId, null, new Date().toISOString());
          }
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
        intent_id: exitIntentId,
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v2",
        reason: "Flatten after amendments.",
        decision_audit: audit("EXIT"),
      });
      assert.equal(receipt.status, "closed");
      assert.equal(receipt.code, "close_contract_submitted");
      assert.equal(store.mutationForIntent(exitIntentId)?.state, "submitted");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
