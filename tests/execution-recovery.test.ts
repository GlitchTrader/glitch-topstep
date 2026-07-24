import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderInfo, TradeIntent } from "../src/domain/models.js";
import { recoverExecutionMutations } from "../src/execution/recovery.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

const accountId = 101;
const contractId = "CON.F.US.MNQ.U26";

function intent(id: string, action: "ENTER_LONG" | "EXIT" = "ENTER_LONG"): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: id,
    createdUtc: "2026-07-21T12:00:04Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action,
    confidence: 0.6,
    snapshotHash: "snapshot-hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v2",
    reason: "Test.",
    decisionAudit: {
      bullCase: "Bull.",
      bearCase: "Bear.",
      flatCase: "Flat.",
      aggressiveCase: "Aggressive.",
      conservativeCase: "Conservative.",
      decisiveEvidence: "Evidence.",
      disconfirmingEvidence: "Counter.",
      changeCondition: "Change.",
      finalChoice: action,
    },
    ...(action === "ENTER_LONG"
      ? {
          quantity: 1,
          orderType: "MARKET" as const,
          stopLoss: 19_990.25,
          takeProfit1: 20_020.25,
        }
      : {}),
  };
}

function historicalOrder(customTag: string): OrderInfo {
  return {
    id: 9001,
    accountId,
    contractId,
    creationTimestamp: "2026-07-21T12:00:10Z",
    updateTimestamp: "2026-07-21T12:00:11Z",
    status: 1,
    type: 2,
    side: 0,
    size: 1,
    limitPrice: null,
    stopPrice: null,
    customTag,
  };
}

describe("durable execution recovery", () => {
  it("closes prepared mutations as proven not submitted", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000001");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-prepared",
      "2026-07-21T12:00:06Z",
    );
    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => [] },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolved, 1);
    assert.equal(store.recoveryStatus().unresolvedMutations, 0);
    store.close();
  });

  it("resolves an ambiguous entry only from an exactly matching ProjectX custom tag", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000002");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-recovered",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
    store.markMutationAmbiguous(value.intentId, "timeout", "2026-07-21T12:00:08Z");

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => [historicalOrder("glt-recovered")] },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolved, 1);
    assert.equal(result.ambiguous, 0);
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    store.close();
  });

  it("keeps entry recovery blocked when no matching provider order exists", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000003");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-missing",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => [] },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.ambiguous, 1);
    assert.equal(store.recoveryStatus().blockingAmbiguity, true);
    store.close();
  });

  it("resolves an uncertain close only when the configured contract is actually flat", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000004", "EXIT");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "close_position",
      { accountId, contractId },
      null,
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => [] },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolved, 1);
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    store.close();
  });
});
