import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { ExecutionCoordinator } from "../src/execution/coordinator.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import type { ProjectXApiClient, PlaceOrderRequest } from "../src/projectx/client.js";
import { JsonlEventStore } from "../src/storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot, orderFlowWithTrades, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";

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
    dataDir,
    reconcileIntervalMs: 3_000,
    packetLeaseMs: 300_000,
    entrySubmissionLatchStaleMs: 300_000,
  };
}

function intent(
  intentId: string,
  snapshotHash: string,
  createdUtc: string,
): Record<string, unknown> {
  return {
    schema_version: "glitch.intent.v2",
    intent_id: intentId,
    created_utc: createdUtc,
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operator_profile: "glitch-topstep",
    action: "ENTER_LONG",
    confidence: 0.6,
    snapshot_hash: snapshotHash,
    model_version: "test",
    prompt_version: "glitch-topstep-v9",
    reason: "Test concurrent entry.",
    decision_audit: {
      bull_case: "Bull case.",
      bear_case: "Bear case.",
      flat_case: "Flat case.",
      aggressive_case: "Aggressive case.",
      conservative_case: "Conservative case.",
      decisive_evidence: "Evidence.",
      disconfirming_evidence: "Counter evidence.",
      change_condition: "Change condition.",
      final_choice: "ENTER_LONG",
    },
    quantity: 1,
    order_type: "MARKET",
    stop_loss: 19_990.25,
    take_profit_1: 20_020.25,
  };
}

describe("execution coordinator serialization", () => {
  it("allows exactly one ProjectX entry across concurrent and newly issued intents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = snapshot();
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
      const healthyRecovery: ExecutionRecoveryStatus = {
        blockingAmbiguity: false,
        entrySubmissionPending: false,
        blockingNewExposure: false,
        unresolvedMutations: 0,
        ambiguousMutations: 0,
        lastRecoveryUtc: null,
        lastRecoveryError: null,
      };
      const firstPacket = buildDecisionPacket(
        current,
        appConfig.policy,
        appConfig.risk,
        healthyRecovery,
        appConfig.scope.instrument,
        appConfig.tradingMode,
        appConfig.packetLeaseMs,
        now,
        undefined,
        orderFlowWithTrades(3),
      );
      store.recordIssuedPacket(firstPacket);

      let placeOrderCalls = 0;
      const api = {
        placeOrder: async () => {
          placeOrderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 9001;
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

      const [first, second] = await Promise.all([
        coordinator.handleWireIntent(intent(
          "00000000-0000-4000-8000-000000000201",
          firstPacket.market.snapshot_hash,
          now.toISOString(),
        )),
        coordinator.handleWireIntent(intent(
          "00000000-0000-4000-8000-000000000202",
          firstPacket.market.snapshot_hash,
          now.toISOString(),
        )),
      ]);

      assert.equal(first.status, "pending");
      assert.equal(first.code, "entry_submitted_pending_reconciliation");
      assert.equal(second.status, "rejected");
      assert.equal(second.code, "decision_packet_unknown_or_expired");
      assert.equal(placeOrderCalls, 1);
      assert.equal(store.recoveryStatus().entrySubmissionPending, true);

      const pendingPacket = buildDecisionPacket(
        current,
        appConfig.policy,
        appConfig.risk,
        store.recoveryStatus(),
        appConfig.scope.instrument,
        appConfig.tradingMode,
        appConfig.packetLeaseMs,
        new Date(),
        undefined,
        orderFlowWithTrades(3),
      );
      store.recordIssuedPacket(pendingPacket);
      const third = await coordinator.handleWireIntent(intent(
        "00000000-0000-4000-8000-000000000203",
        pendingPacket.market.snapshot_hash,
        new Date().toISOString(),
      ));
      assert.equal(third.status, "rejected");
      assert.equal(third.code, "entry_submission_pending");
      assert.equal(placeOrderCalls, 1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects the same intent_id with a different body hash", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-conflict-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = snapshot();
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
      const packet = buildDecisionPacket(
        current,
        appConfig.policy,
        appConfig.risk,
        {
          blockingAmbiguity: false,
          entrySubmissionPending: false,
          blockingNewExposure: false,
          unresolvedMutations: 0,
          ambiguousMutations: 0,
          lastRecoveryUtc: null,
          lastRecoveryError: null,
        },
        appConfig.scope.instrument,
        appConfig.tradingMode,
        appConfig.packetLeaseMs,
        now,
        undefined,
        orderFlowWithTrades(3),
      );
      store.recordIssuedPacket(packet);
      const coordinator = new ExecutionCoordinator(
        appConfig,
        { placeOrder: async () => 9001, closePosition: async () => undefined } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const base = intent(
        "00000000-0000-4000-8000-000000000301",
        packet.market.snapshot_hash,
        now.toISOString(),
      );
      const conflicting = { ...base, reason: "Different body hash." };
      const first = await coordinator.handleWireIntent(base);
      const second = await coordinator.handleWireIntent(conflicting);
      assert.equal(first.status, "pending");
      assert.equal(first.code, "entry_submitted_pending_reconciliation");
      assert.equal(second.status, "rejected");
      assert.equal(second.code, "intent_body_conflict");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("executes exactly one provider mutation across one hundred identical intents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-barrier-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = snapshot();
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
      const packet = buildDecisionPacket(
        current,
        appConfig.policy,
        appConfig.risk,
        {
          blockingAmbiguity: false,
          entrySubmissionPending: false,
          blockingNewExposure: false,
          unresolvedMutations: 0,
          ambiguousMutations: 0,
          lastRecoveryUtc: null,
          lastRecoveryError: null,
        },
        appConfig.scope.instrument,
        appConfig.tradingMode,
        appConfig.packetLeaseMs,
        now,
        undefined,
        orderFlowWithTrades(3),
      );
      store.recordIssuedPacket(packet);
      let placeOrderCalls = 0;
      const api = {
        placeOrder: async () => {
          placeOrderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 9001;
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
      const wireIntent = intent(
        "00000000-0000-4000-8000-000000000401",
        packet.market.snapshot_hash,
        now.toISOString(),
      );
      const receipts = await Promise.all(
        Array.from({ length: 100 }, () => coordinator.handleWireIntent(wireIntent)),
      );
      assert.equal(placeOrderCalls, 1);
      assert.equal(receipts.every((receipt) => receipt.status === "pending"), true);
      assert.equal(new Set(receipts.map((receipt) => receipt.receipt_id)).size, 1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts NOTHING without an issued decision packet", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-nothing-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      appConfig.tradingMode = "shadow";
      const coordinator = new ExecutionCoordinator(
        appConfig,
        { placeOrder: async () => 9001, closePosition: async () => undefined } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => snapshot(),
        () => null,
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v2",
        intent_id: "00000000-0000-4000-8000-000000000501",
        created_utc: new Date().toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "NOTHING",
        confidence: 0.4,
        snapshot_hash: "expired-or-unknown-hash",
        model_version: "test",
        prompt_version: "glitch-topstep-v9",
        reason: "No trade this cycle.",
        decision_audit: {
          bull_case: "Bull case.",
          bear_case: "Bear case.",
          flat_case: "Flat case.",
          aggressive_case: "Aggressive case.",
          conservative_case: "Conservative case.",
          decisive_evidence: "Evidence.",
          disconfirming_evidence: "Counter evidence.",
          change_condition: "Change condition.",
          final_choice: "NOTHING",
        },
      });
      assert.equal(receipt.status, "ignored");
      assert.equal(receipt.code, "no_execution_action");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("submits signed ProjectX bracket ticks for protected long entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-brackets-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const current = snapshot();
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
      const packet = buildDecisionPacket(
        current,
        appConfig.policy,
        appConfig.risk,
        {
          blockingAmbiguity: false,
          entrySubmissionPending: false,
          blockingNewExposure: false,
          unresolvedMutations: 0,
          ambiguousMutations: 0,
          lastRecoveryUtc: null,
          lastRecoveryError: null,
        },
        appConfig.scope.instrument,
        appConfig.tradingMode,
        appConfig.packetLeaseMs,
        now,
        undefined,
        orderFlowWithTrades(3),
      );
      store.recordIssuedPacket(packet);
      let captured: PlaceOrderRequest | undefined;
      const api = {
        placeOrder: async (request: PlaceOrderRequest) => {
          captured = request;
          return 9001;
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
      const receipt = await coordinator.handleWireIntent(intent(
        "00000000-0000-4000-8000-000000000601",
        packet.market.snapshot_hash,
        now.toISOString(),
      ));
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "entry_submitted_pending_reconciliation");
      const placed = captured;
      if (!placed?.stopLossBracket || !placed.takeProfitBracket) {
        throw new Error("expected signed bracket request");
      }
      assert.ok(placed.stopLossBracket.ticks < 0, "long stop ticks must be negative");
      assert.ok(placed.takeProfitBracket.ticks > 0, "long target ticks must be positive");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns structured field and error metadata for schema-invalid intents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-invalid-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const coordinator = new ExecutionCoordinator(
        appConfig,
        { placeOrder: async () => 9001, closePosition: async () => undefined } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => snapshot(),
        () => null,
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const receipt = await coordinator.handleWireIntent({
        ...intent("00000000-0000-4000-8000-000000000701", "snapshot", new Date().toISOString()),
        prompt_version: "glitch-topstep-v1",
      });
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.code, "intent_schema_invalid");
      assert.equal(receipt.field, "prompt_version");
      assert.equal(receipt.error, "prompt_version_mismatch");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
