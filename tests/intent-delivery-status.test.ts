import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveIntentDeliveryState,
  resolveIntentReceiptResponse,
  type IntentDeliveryStatusV1,
} from "../src/domain/intent-delivery-status.js";
import type { TradeAction, TradeIntent } from "../src/domain/models.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

function testIntent(id: string, action: TradeAction = "ENTER_LONG"): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: id,
    createdUtc: "2026-08-31T12:00:04Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action,
    confidence: 0.6,
    snapshotHash: "snapshot-hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v17.1",
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
    quantity: 1,
    orderType: "MARKET",
    stopLoss: 19_990.25,
    takeProfit1: 20_020.25,
  };
}

function status(state: IntentDeliveryStatusV1["status"]): IntentDeliveryStatusV1 {
  return {
    schema_version: "glitch.topstep.intent_delivery_status.v1",
    intent_id: "00000000-0000-4000-8000-00000000a001",
    status: state,
    receipt_status: null,
    mutation_state: null,
    retention_generation: 1,
  };
}

describe("TS-REAUDIT-04 intent delivery status", () => {
  it("maps store rows to the paired contract states", () => {
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: false, mutationState: null, receiptStatus: null }),
      "not_seen",
    );
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: true, mutationState: null, receiptStatus: null }),
      "registered",
    );
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: true, mutationState: "prepared", receiptStatus: null }),
      "mutation_inflight",
    );
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: true, mutationState: "ambiguous", receiptStatus: null }),
      "ambiguous",
    );
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: true, mutationState: null, receiptStatus: "ambiguous" }),
      "ambiguous",
    );
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: true, mutationState: "submitting", receiptStatus: "pending" }),
      "mutation_inflight",
    );
    assert.equal(
      deriveIntentDeliveryState({ hasIntent: true, mutationState: null, receiptStatus: "rejected" }),
      "terminal",
    );
  });

  it("GET /intent/receipt: a persisted receipt always wins, regardless of delivery status", () => {
    const receipt = { intentId: "x", status: "shadowed" };
    const resolved = resolveIntentReceiptResponse(receipt, status("terminal"));
    assert.equal(resolved.httpStatus, 200);
    assert.equal(resolved.body, receipt);
  });

  it("GET /intent/receipt: 404 only when the gateway genuinely never saw the intent", () => {
    const resolved = resolveIntentReceiptResponse(null, status("not_seen"));
    assert.equal(resolved.httpStatus, 404);
    assert.deepEqual(resolved.body, { error: "intent_receipt_not_found" });
  });

  it("GET /intent/receipt: registered but no receipt yet is 200 with delivery status, not 404 (TS-REAUDIT-04)", () => {
    // This is the exact ambiguity the ticket flags: a bare 404 here previously let a caller
    // read "no receipt" as "safe to discard" for an intent that is very much still live.
    for (const state of ["registered", "mutation_inflight", "ambiguous", "terminal"] as const) {
      const resolved = resolveIntentReceiptResponse(null, status(state));
      assert.equal(resolved.httpStatus, 200, `expected 200 for ${state}`);
      assert.deepEqual(resolved.body, status(state));
    }
  });
});

describe("TS-REAUDIT-04 crash/restart through the real store", () => {
  it("a crash right after intent registration, before any receipt, reads as 'registered' -- not 404-worthy", () => {
    const store = new SqliteExecutionStore(":memory:");
    const id = "00000000-0000-4000-8000-000000000201";
    store.registerIntent(testIntent(id), "2026-08-31T12:00:05Z");

    // Simulates the process restarting here, before a receipt or mutation was ever recorded.
    const delivery = store.intentDeliveryStatus(id);
    assert.equal(delivery.status, "registered");
    assert.equal(store.receiptForIntent(id), null);

    const resolved = resolveIntentReceiptResponse(store.receiptForIntent(id), delivery);
    assert.equal(resolved.httpStatus, 200, "must not 404 a live, non-terminal intent");
    assert.equal((resolved.body as IntentDeliveryStatusV1).status, "registered");
  });

  it("a crash after the mutation starts, before a receipt, reads as 'mutation_inflight'", () => {
    const store = new SqliteExecutionStore(":memory:");
    const id = "00000000-0000-4000-8000-000000000202";
    store.registerIntent(testIntent(id), "2026-08-31T12:00:05Z");
    store.prepareMutation(id, "place_order", { intentId: id }, `glt-${id}`, "2026-08-31T12:00:06Z");

    // Simulates the process restarting here, mid-mutation, before ProjectX's response was ever
    // durably recorded as a receipt.
    const delivery = store.intentDeliveryStatus(id);
    assert.equal(delivery.status, "mutation_inflight");
    assert.equal(delivery.mutation_state, "prepared");

    const resolved = resolveIntentReceiptResponse(store.receiptForIntent(id), delivery);
    assert.equal(resolved.httpStatus, 200, "must not 404 a live, non-terminal intent");
  });

  it("not_seen only for an intent id this store never registered", () => {
    const store = new SqliteExecutionStore(":memory:");
    const delivery = store.intentDeliveryStatus("00000000-0000-4000-8000-000000000999");
    assert.equal(delivery.status, "not_seen");
    const resolved = resolveIntentReceiptResponse(null, delivery);
    assert.equal(resolved.httpStatus, 404);
  });
});
