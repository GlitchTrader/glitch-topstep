import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveIntentDeliveryState } from "../src/domain/intent-delivery-status.js";

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
});
