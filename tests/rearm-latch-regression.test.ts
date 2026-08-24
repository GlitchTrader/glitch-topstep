import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { TradeIntent } from "../src/domain/models.js";
import { ExecutionCoordinator } from "../src/execution/coordinator.js";
import type { TrancheView } from "../src/ownership/tranches.js";
import type { ProjectXApiClient } from "../src/projectx/client.js";
import { JsonlEventStore } from "../src/storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { snapshot, testDailyEconomicsConfig, testSessionConfig } from "./fixtures.js";

const ENTRY_INTENT_ID = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

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

function nakedPositionSnapshot(intentId: string) {
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
  current.openOrders = [];
  const now = new Date();
  current.capturedAt = now.toISOString();
  current.quote = {
    ...current.quote!,
    timestamp: now.toISOString(),
    bestBid: 20_000,
    bestAsk: 20_000.25,
    lastPrice: 20_000,
  };
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
      status: "pending",
      reason: "no_working_protective_orders",
      stop: { provider_order_id: null, custom_tag: "", price: null },
      target: { provider_order_id: null, custom_tag: "", price: null },
    },
  };
}

describe("TS-AUDIT-05 rearm latch regression", () => {
  it("retries target rearm after a partial protection failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-rearm-latch-"));
    const store = new SqliteExecutionStore(":memory:");
    try {
      const entry: TradeIntent = {
        schemaVersion: "glitch.intent.v2",
        intentId: ENTRY_INTENT_ID,
        createdUtc: "2026-07-21T12:00:04Z",
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operatorProfile: "glitch-topstep",
        action: "ENTER_LONG",
        confidence: 0.6,
        snapshotHash: "snapshot-hash",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v13",
        reason: "Entry for partial rearm failure.",
        decisionAudit: {
          bullCase: "Bull.",
          bearCase: "Bear.",
          flatCase: "Flat.",
          aggressiveCase: "Aggressive.",
          conservativeCase: "Conservative.",
          decisiveEvidence: "Evidence.",
          disconfirmingEvidence: "Counter.",
          changeCondition: "Change.",
          finalChoice: "ENTER_LONG",
        },
        quantity: 1,
        orderType: "MARKET",
        stopLoss: 19_990,
        takeProfit1: 20_020,
      };
      store.registerIntent(entry, "2026-07-21T12:00:05Z");
      store.prepareMutation(
        entry.intentId,
        "place_order",
        { accountId: 101, contractId: "CON.F.US.MNQ.U26", type: 2, side: 0, size: 1 },
        `glt-${ENTRY_INTENT_ID}`,
        "2026-07-21T12:00:06Z",
      );
      store.markMutationSubmitting(entry.intentId, "2026-07-21T12:00:07Z");
      store.markMutationSubmitted(entry.intentId, 9001, "2026-07-21T12:00:08Z");

      const current = nakedPositionSnapshot(ENTRY_INTENT_ID);

      let targetAttempts = 0;
      const placed: Array<{ type: number; customTag?: string | null }> = [];
      const api = {
        placeOrder: async (request: { type: number; customTag?: string | null }) => {
          placed.push({ type: request.type, customTag: request.customTag });
          if (request.type === 1) {
            targetAttempts += 1;
            if (targetAttempts === 1) {
              throw new Error("projectx_target_rearm_failed");
            }
          }
          return 9400 + placed.length;
        },
        modifyOrder: async () => undefined,
        closePosition: async () => undefined,
        searchOrders: async () => [],
        cancelOrder: async () => undefined,
      } as unknown as ProjectXApiClient;

      const coordinator = new ExecutionCoordinator(
        config(directory),
        api,
        new JsonlEventStore(directory),
        store,
        () => current,
        () => null,
        () => undefined,
        () => [tranche(ENTRY_INTENT_ID, 1, 9001)],
      );

      const first = await coordinator.rearmTrancheProtection(current);
      assert.equal(first, true);
      assert.equal(placed.filter((order) => order.type === 4).length, 1);
      assert.equal(placed.filter((order) => order.type === 1).length, 1);

      const second = await coordinator.rearmTrancheProtection(current);
      assert.equal(second, true, "partial target failure must remain retryable on the next reconcile");
      assert.equal(placed.filter((order) => order.type === 1).length, 2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
