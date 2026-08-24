import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderInfo, PositionInfo } from "../src/domain/models.js";
import {
  attemptBoundedRecoveryFlattens,
  provesBoundedRecoveryOwnership,
  recoveryFlattenIntentId,
} from "../src/execution/recovery-flatten.js";
import { recoverExecutionMutations } from "../src/execution/recovery.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

const accountId = 101;
const contractId = "CON.F.US.MNQ.U26";

function openPosition(): PositionInfo {
  return {
    id: 1,
    accountId,
    contractId,
    creationTimestamp: "2026-07-21T12:00:10Z",
    type: 1,
    size: 1,
    averagePrice: 20_000,
  };
}

function taggedOrder(customTag: string): OrderInfo {
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

describe("bounded recovery flatten", () => {
  it("proves ownership only from exact custom-tag or provider-order identity", () => {
    const mutation = {
      intentId: "00000000-0000-4000-8000-000000000501",
      operation: "place_order" as const,
      state: "ambiguous" as const,
      customTag: "glt-owned",
      request: { accountId, contractId, type: 2, side: 0, size: 1 },
      createdUtc: "2026-07-21T12:00:06Z",
      submittingUtc: "2026-07-21T12:00:07Z",
      resolvedUtc: null,
      providerOrderId: null,
      lastError: "timeout",
    };
    assert.equal(
      provesBoundedRecoveryOwnership(mutation, [], [taggedOrder("glt-owned")], accountId, contractId).owned,
      true,
    );
    assert.equal(
      provesBoundedRecoveryOwnership(mutation, [], [], accountId, contractId).owned,
      false,
    );
  });

  it("submits one scoped close_position for owned ambiguous entry exposure", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const entryIntentId = "00000000-0000-4000-8000-000000000502";
    const customTag = "glt-owned-entry";
    let closeCalls = 0;
    const api = {
      searchOrders: async () => [],
      closePosition: async () => {
        closeCalls += 1;
      },
    };

    store.registerIntent({
      schemaVersion: "glitch.intent.v2",
      intentId: entryIntentId,
      createdUtc: "2026-07-21T12:00:04Z",
      instrument: "MNQ",
      account: "TEST_ACCOUNT",
      operatorProfile: "glitch-topstep",
      action: "ENTER_LONG",
      confidence: 0.6,
      snapshotHash: "snapshot-hash",
      modelVersion: "test",
      promptVersion: "glitch-topstep-v14",
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
        finalChoice: "ENTER_LONG",
      },
      quantity: 1,
      orderType: "MARKET",
      stopLoss: 19_990.25,
      takeProfit1: 20_020.25,
    }, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      entryIntentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      customTag,
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(entryIntentId, "2026-07-21T12:00:07Z");
    store.markMutationAmbiguous(entryIntentId, "transport_timeout", "2026-07-21T12:00:08Z");

    const result = await recoverExecutionMutations(
      store,
      api,
      accountId,
      contractId,
      [openPosition()],
      new Date("2026-07-21T12:05:00Z"),
      {
        accountName: "TEST_ACCOUNT",
        instrument: "MNQ",
        openOrders: [taggedOrder(customTag)],
      },
    );

    assert.equal(closeCalls, 1);
    assert.ok(result.resolutions.some((item) => item.code === "bounded_recovery_flatten_submitted"));
    assert.equal(store.mutationForIntent(entryIntentId)?.state, "submitted");
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    const recoveryIntentId = recoveryFlattenIntentId(entryIntentId);
    assert.equal(store.mutationForIntent(recoveryIntentId)?.operation, "close_position");
    assert.equal(store.mutationForIntent(recoveryIntentId)?.state, "submitted");
    store.close();
  });

  it("does not flatten when custom-tag ownership cannot be proven", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const entryIntentId = "00000000-0000-4000-8000-000000000503";
    let closeCalls = 0;
    store.registerIntent({
      schemaVersion: "glitch.intent.v2",
      intentId: entryIntentId,
      createdUtc: "2026-07-21T12:00:04Z",
      instrument: "MNQ",
      account: "TEST_ACCOUNT",
      operatorProfile: "glitch-topstep",
      action: "ENTER_LONG",
      confidence: 0.6,
      snapshotHash: "snapshot-hash",
      modelVersion: "test",
      promptVersion: "glitch-topstep-v14",
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
        finalChoice: "ENTER_LONG",
      },
      quantity: 1,
      orderType: "MARKET",
      stopLoss: 19_990.25,
      takeProfit1: 20_020.25,
    }, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      entryIntentId,
      "place_order",
      { accountId, contractId, type: 2, side: 0, size: 1 },
      "glt-missing",
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(entryIntentId, "2026-07-21T12:00:07Z");
    store.markMutationAmbiguous(entryIntentId, "transport_timeout", "2026-07-21T12:00:08Z");

    await attemptBoundedRecoveryFlattens(
      store,
      {
        searchOrders: async () => [],
        closePosition: async () => {
          closeCalls += 1;
        },
      },
      accountId,
      contractId,
      "TEST_ACCOUNT",
      "MNQ",
      [openPosition()],
      [],
      [],
      new Date("2026-07-21T12:05:00Z"),
    );

    assert.equal(closeCalls, 0);
    assert.equal(store.mutationForIntent(entryIntentId)?.state, "ambiguous");
    store.close();
  });
});
