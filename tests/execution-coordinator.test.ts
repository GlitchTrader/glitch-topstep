import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import { ExecutionCoordinator } from "../src/execution/coordinator.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import type { ProjectXApiClient, ModifyOrderRequest, PlaceOrderRequest } from "../src/projectx/client.js";
import type { TrancheView } from "../src/ownership/tranches.js";
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
  packet?: {
    packet_id: string;
    contract: { id: string };
    decision_scope: { scope_hash: string; generation: number };
    expires_utc: string;
    market: { bid: number | null; ask: number | null };
  },
): Record<string, unknown> {
  return {
    schema_version: "glitch.intent.v3",
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
    packet_id: packet?.packet_id,
    contract_id: packet?.contract.id,
    scope_hash: packet?.decision_scope.scope_hash,
    scope_generation: packet?.decision_scope.generation,
    expires_utc: packet?.expires_utc,
    entry_price_min: packet ? (packet.market.bid ?? packet.market.ask) : undefined,
    entry_price_max: packet ? (packet.market.ask ?? packet.market.bid) : undefined,
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
          firstPacket,
        )),
        coordinator.handleWireIntent(intent(
          "00000000-0000-4000-8000-000000000202",
          firstPacket.market.snapshot_hash,
          now.toISOString(),
          firstPacket,
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
        pendingPacket,
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
        packet,
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
        packet,
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
        packet,
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

  it("admits same-contract scale-in when ownership already proved protection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-coordinator-scale-in-"));
    const store = new SqliteExecutionStore(":memory:");
    const entryIntentId = "00000000-0000-4000-8000-00000000a001";
    try {
      const appConfig = config(directory);
      const current = snapshot();
      const now = new Date();
      current.capturedAt = now.toISOString();
      current.quote = { ...current.quote!, timestamp: now.toISOString() };
      current.instrumentOpenContracts = 1;
      current.totalOpenContracts = 1;
      current.positions = [{
        id: 1,
        accountId: 101,
        contractId: appConfig.scope.contractId,
        creationTimestamp: now.toISOString(),
        type: 2,
        size: 1,
        averagePrice: 20_000,
      }];
      current.openOrders = [{
        id: 9201,
        accountId: 101,
        contractId: appConfig.scope.contractId,
        creationTimestamp: now.toISOString(),
        updateTimestamp: now.toISOString(),
        status: 1,
        type: 4,
        side: 0,
        size: 1,
        limitPrice: null,
        stopPrice: 20_010,
        customTag: `glt-${entryIntentId}-SL`,
      }, {
        id: 9202,
        accountId: 101,
        contractId: appConfig.scope.contractId,
        creationTimestamp: now.toISOString(),
        updateTimestamp: now.toISOString(),
        status: 1,
        type: 1,
        side: 0,
        size: 1,
        limitPrice: 19_980,
        stopPrice: null,
        customTag: `glt-${entryIntentId}-TP`,
      }];
      const provenTranche: TrancheView = {
        intent_id: entryIntentId,
        entry_order_id: 9001,
        filled_qty: 1,
        remaining_qty: 1,
        created_utc: now.toISOString(),
        protection: {
          status: "proven",
          reason: "provider_child_orders_bound_by_custom_tag",
          stop: {
            provider_order_id: 9201,
            custom_tag: `glt-${entryIntentId}-SL`,
            price: 20_010,
          },
          target: {
            provider_order_id: 9202,
            custom_tag: `glt-${entryIntentId}-TP`,
            price: 19_980,
          },
        },
      };
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
        [provenTranche],
      );
      assert.equal(packet.protection.status, "proven");
      assert.ok(packet.execution.supported_actions.includes("ENTER_SHORT"));
      store.recordIssuedPacket(packet);
      let placeOrderCalls = 0;
      const coordinator = new ExecutionCoordinator(
        appConfig,
        {
          placeOrder: async () => {
            placeOrderCalls += 1;
            return 9002;
          },
          closePosition: async () => undefined,
        } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
      );
      const receipt = await coordinator.handleWireIntent({
        ...intent(
          "00000000-0000-4000-8000-000000000801",
          packet.market.snapshot_hash,
          now.toISOString(),
          packet,
        ),
        action: "ENTER_SHORT",
        reason: "Same-contract protected scale-in.",
        decision_audit: {
          bull_case: "Bull case.",
          bear_case: "Bear case.",
          flat_case: "Flat case.",
          aggressive_case: "Aggressive case.",
          conservative_case: "Conservative case.",
          decisive_evidence: "Evidence.",
          disconfirming_evidence: "Counter evidence.",
          change_condition: "Change condition.",
          final_choice: "ENTER_SHORT",
        },
        stop_loss: 20_010.25,
        take_profit_1: 19_980.25,
      });
      assert.notEqual(receipt.code, "portfolio_protection_unproven");
      assert.equal(receipt.status, "pending");
      assert.equal(receipt.code, "entry_submitted_pending_reconciliation");
      assert.equal(placeOrderCalls, 1);
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

describe("daily capture lock (TS-CAP-02)", () => {
  const trancheIntentId = "00000000-0000-4000-8000-00000000b001";

  /** One owned short lot at 20_000 with a proven bracket resting 10 points away. */
  function ownedShortSnapshot(appConfig: AppConfig, now: Date) {
    const current = snapshot();
    current.capturedAt = now.toISOString();
    current.quote = { ...current.quote!, timestamp: now.toISOString() };
    current.instrumentOpenContracts = 1;
    current.totalOpenContracts = 1;
    current.positions = [{
      id: 1,
      accountId: appConfig.scope.accountId,
      contractId: appConfig.scope.contractId,
      creationTimestamp: now.toISOString(),
      type: 2,
      size: 1,
      averagePrice: 20_000,
    }];
    current.openOrders = [{
      id: 9201,
      accountId: appConfig.scope.accountId,
      contractId: appConfig.scope.contractId,
      creationTimestamp: now.toISOString(),
      updateTimestamp: now.toISOString(),
      status: 1,
      type: 4,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: 20_010,
      customTag: `glt-${trancheIntentId}-SL`,
    }, {
      id: 9202,
      accountId: appConfig.scope.accountId,
      contractId: appConfig.scope.contractId,
      creationTimestamp: now.toISOString(),
      updateTimestamp: now.toISOString(),
      status: 1,
      type: 1,
      side: 0,
      size: 1,
      limitPrice: 19_980,
      stopPrice: null,
      customTag: `glt-${trancheIntentId}-TP`,
    }];
    return current;
  }

  function ownedTranche(now: Date): TrancheView {
    return {
      intent_id: trancheIntentId,
      entry_order_id: 9001,
      filled_qty: 1,
      remaining_qty: 1,
      created_utc: now.toISOString(),
      protection: {
        status: "proven",
        reason: "provider_child_orders_bound_by_custom_tag",
        stop: { provider_order_id: 9201, custom_tag: `glt-${trancheIntentId}-SL`, price: 20_010 },
        target: { provider_order_id: 9202, custom_tag: `glt-${trancheIntentId}-TP`, price: 19_980 },
      },
    };
  }

  it("keeps the latch across a store reopen and scoped to its trading day", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-capture-latch-"));
    const path = join(directory, "execution.sqlite");
    let store = new SqliteExecutionStore(path);
    try {
      store.latchDailyCapture("2026-08-20", "2026-08-20T18:00:00.000Z");
      assert.equal(store.isDailyCaptureLocked("2026-08-20"), true);
      store.close();

      store = new SqliteExecutionStore(path);
      assert.equal(store.isDailyCaptureLocked("2026-08-20"), true);
      assert.equal(store.isDailyCaptureLocked("2026-08-21"), false);
      // Re-latching the same day stays a no-op rather than raising on the primary key.
      store.latchDailyCapture("2026-08-20", "2026-08-20T19:00:00.000Z");
      assert.equal(store.isDailyCaptureLocked("2026-08-20"), true);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks new exposure while the latch is held", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-capture-enter-"));
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
      const coordinator = new ExecutionCoordinator(
        appConfig,
        {
          placeOrder: async () => {
            placeOrderCalls += 1;
            return 9001;
          },
          closePosition: async () => undefined,
        } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
        () => [],
        () => ({ paused: false, mode: "armed" }),
        () => true,
      );
      const receipt = await coordinator.handleWireIntent(intent(
        "00000000-0000-4000-8000-00000000b101",
        packet.market.snapshot_hash,
        now.toISOString(),
        packet,
      ));
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.code, "daily_capture_new_exposure_locked");
      assert.equal(placeOrderCalls, 0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a widening stop amendment on latched owned exposure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-capture-widen-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const now = new Date();
      const current = ownedShortSnapshot(appConfig, now);
      const tranche = ownedTranche(now);
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
        [tranche],
        appConfig.session,
        null,
        null,
        undefined,
        true,
      );
      assert.equal(packet.execution.daily_capture_locked, true);
      assert.equal(packet.execution.supported_actions.includes("ENTER_SHORT"), false);
      assert.equal(packet.execution.supported_actions.includes("MOVE_STOP"), true);
      assert.equal(packet.execution.supported_actions.includes("EXIT"), true);
      store.recordIssuedPacket(packet);
      let modifyCalls = 0;
      const coordinator = new ExecutionCoordinator(
        appConfig,
        {
          placeOrder: async () => 9003,
          closePosition: async () => undefined,
          modifyOrder: async () => {
            modifyCalls += 1;
          },
        } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => current,
        (snapshotHash) => store.resolveIssuedPacket(snapshotHash, new Date().toISOString()),
        () => store.invalidateIssuedPackets(new Date().toISOString()),
        () => [tranche],
        () => ({ paused: false, mode: "armed" }),
        () => true,
      );
      const receipt = await coordinator.handleWireIntent({
        schema_version: "glitch.intent.v3",
        intent_id: "00000000-0000-4000-8000-00000000b201",
        created_utc: now.toISOString(),
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operator_profile: "glitch-topstep",
        action: "MOVE_STOP",
        confidence: 0.6,
        snapshot_hash: packet.market.snapshot_hash,
        model_version: "test",
        prompt_version: "glitch-topstep-v9",
        reason: "Widen the stop after capture.",
        decision_audit: {
          bull_case: "Bull case.",
          bear_case: "Bear case.",
          flat_case: "Flat case.",
          aggressive_case: "Aggressive case.",
          conservative_case: "Conservative case.",
          decisive_evidence: "Evidence.",
          disconfirming_evidence: "Counter evidence.",
          change_condition: "Change condition.",
          final_choice: "MOVE_STOP",
        },
        new_stop_price: 20_020,
      });
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.code, "stop_would_widen");
      assert.equal(modifyCalls, 0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tightens owned stops to breakeven after the latch without forcing an exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-capture-tighten-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const appConfig = config(directory);
      const now = new Date();
      const current = ownedShortSnapshot(appConfig, now);
      const tranche = ownedTranche(now);
      const modified: ModifyOrderRequest[] = [];
      let closeCalls = 0;
      const coordinator = new ExecutionCoordinator(
        appConfig,
        {
          placeOrder: async () => 9003,
          closePosition: async () => {
            closeCalls += 1;
          },
          modifyOrder: async (request: ModifyOrderRequest) => {
            modified.push(request);
          },
        } as unknown as ProjectXApiClient,
        new JsonlEventStore(directory),
        store,
        () => current,
        () => null,
        () => store.invalidateIssuedPackets(new Date().toISOString()),
        () => [tranche],
        () => ({ paused: false, mode: "armed" }),
        () => true,
      );

      assert.equal(await coordinator.tightenOwnedStopsAfterCaptureLock(), 1);
      assert.deepEqual(modified, [{ accountId: 101, orderId: 9201, stopPrice: 20_000 }]);

      // Venue now reflects the tightened stop: repeating the sweep converges instead of re-amending.
      current.openOrders[0]!.stopPrice = 20_000;
      assert.equal(await coordinator.tightenOwnedStopsAfterCaptureLock(), 0);

      // A stop already past breakeven is left alone rather than widened back to entry.
      current.openOrders[0]!.stopPrice = 19_990;
      assert.equal(await coordinator.tightenOwnedStopsAfterCaptureLock(), 0);

      current.positions = [];
      current.openOrders = [];
      current.instrumentOpenContracts = 0;
      current.totalOpenContracts = 0;
      assert.equal(await coordinator.tightenOwnedStopsAfterCaptureLock(), 0);

      assert.equal(modified.length, 1);
      assert.equal(closeCalls, 0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
