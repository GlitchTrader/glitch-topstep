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
    assert.equal(result.resolutions[0]?.outcome, "confirmed_not_submitted");
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
    assert.equal(result.resolutions[0]?.providerOrderId, 9001);
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
    assert.equal(result.resolutions[0]?.outcome, "ambiguous");
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
    assert.equal(result.resolutions[0]?.code, "close_recovered_from_flat_provider_state");
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    store.close();
  });

  it("recovers ambiguous modify mutations with tick-aligned fractional prices", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const intentId = "00000000-0000-4000-8000-000000000006";
    const moveStopIntent: TradeIntent = {
      ...intent(intentId),
      action: "MOVE_STOP",
      newStopPrice: 20_055.75,
    };
    store.registerIntent(moveStopIntent, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      intentId,
      "modify_order",
      { accountId, contractId, orderId: 9101, stopPrice: 20_055.75 },
      "glt-stop",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(intentId, "2026-07-21T12:00:07Z");
    store.markMutationAmbiguous(intentId, "timeout", "2026-07-21T12:00:08Z");

    const result = await recoverExecutionMutations(
      store,
      {
        searchOrders: async () => [{
          id: 9101,
          accountId,
          contractId,
          creationTimestamp: "2026-07-21T12:00:10Z",
          updateTimestamp: "2026-07-21T12:00:11Z",
          status: 1,
          type: 4,
          side: 1,
          size: 1,
          limitPrice: null,
          stopPrice: 20_055.75,
          customTag: "glt-stop",
        }],
      },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolved, 1);
    assert.equal(result.ambiguous, 0);
    assert.equal(result.resolutions[0]?.code, "modify_recovered_from_projectx_order_state");
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    store.close();
  });

  it("keeps recovery ambiguous when a durable provider order id is absent from history", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000007");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-filled",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
    store.noteMutationProviderOrderId(value.intentId, 9002);

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => [] },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolved, 0);
    assert.equal(result.ambiguous, 1);
    assert.equal(result.resolutions[0]?.outcome, "ambiguous");
    assert.match(result.resolutions[0]?.detail ?? "", /provider_order_id_not_found/);
    assert.equal(store.recoveryStatus().blockingAmbiguity, true);
    store.close();
  });

  it("resolves an entry from a durable provider order id when history still matches identity", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000008");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-filled-match",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
    store.noteMutationProviderOrderId(value.intentId, 9003);

    const result = await recoverExecutionMutations(
      store,
      {
        searchOrders: async () => [{
          id: 9003,
          accountId,
          contractId,
          creationTimestamp: "2026-07-21T12:00:08Z",
          updateTimestamp: "2026-07-21T12:00:08Z",
          status: 2,
          type: 2,
          side: 0,
          size: 1,
          limitPrice: null,
          stopPrice: null,
          customTag: null,
        }],
      },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolved, 1);
    assert.equal(result.ambiguous, 0);
    assert.equal(result.resolutions[0]?.providerOrderId, 9003);
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    store.close();
  });

  it("reconstructs a receipt when submitted state survived but the receipt did not", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000005");
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-terminal",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
    store.markMutationSubmitted(value.intentId, 9001, "2026-07-21T12:00:08Z");

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => { throw new Error("historical lookup must not run"); } },
      accountId,
      contractId,
      [],
      new Date("2026-07-21T12:01:00Z"),
    );
    assert.equal(result.resolutions.length, 1);
    assert.equal(result.resolutions[0]?.code, "entry_receipt_reconstructed_from_durable_state");
    assert.equal(result.resolutions[0]?.providerOrderId, 9001);
    store.close();
  });
});
