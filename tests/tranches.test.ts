import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntryOrderOwnership } from "../src/domain/order-ownership.js";
import { buildTranches } from "../src/ownership/tranches.js";

const ENTRY_A = "00000000-0000-4000-8000-00000000a001";
const ENTRY_B = "00000000-0000-4000-8000-00000000a002";

function entry(
  intentId: string,
  filledQty: number,
  providerOrderId: number,
  protectionLive = true,
): EntryOrderOwnership {
  return {
    intentId,
    account: "TEST_ACCOUNT",
    instrument: "MNQ",
    action: "ENTER_LONG",
    quantity: filledQty,
    plannedStopLoss: 19_990,
    plannedTakeProfit: 20_020,
    customTag: `glt-${intentId}`,
    providerOrderId,
    status: "provider_observed",
    orderEvidenceSequences: [1],
    latestObservedOrder: null,
    fills: [],
    effectiveFilledQuantity: filledQty,
    protection: {
      status: protectionLive ? "proven" : "pending",
      reason: protectionLive
        ? "provider_child_orders_bound_by_custom_tag"
        : "stop_child_not_observed;target_child_not_observed",
      stop: {
        customTag: `glt-${intentId}-SL`,
        providerOrderId: protectionLive ? providerOrderId + 10 : null,
        price: protectionLive ? 19_990 : null,
        observedOrder: null,
      },
      target: {
        customTag: `glt-${intentId}-TP`,
        providerOrderId: protectionLive ? providerOrderId + 11 : null,
        price: protectionLive ? 20_020 : null,
        observedOrder: null,
      },
    },
    issues: [],
  };
}

const CREATED = new Map([
  [ENTRY_A, "2026-07-21T12:00:05Z"],
  [ENTRY_B, "2026-07-21T12:00:06Z"],
]);

describe("tranche projection", () => {
  it("builds tranches from multiple filled entries", () => {
    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001), entry(ENTRY_B, 2, 9002)],
      CREATED,
      3,
    );
    assert.equal(tranches.length, 2);
    assert.equal(tranches[0]?.intent_id, ENTRY_A);
    assert.equal(tranches[0]?.filled_qty, 1);
    assert.equal(tranches[0]?.remaining_qty, 1);
    assert.equal(tranches[0]?.entry_order_id, 9001);
    assert.equal(tranches[1]?.intent_id, ENTRY_B);
    assert.equal(tranches[1]?.filled_qty, 2);
    assert.equal(tranches[1]?.remaining_qty, 2);
    assert.equal(tranches[0]?.protection.stop.provider_order_id, 9011);
  });

  it("reports no active tranche when the venue is flat", () => {
    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001), entry(ENTRY_B, 1, 9002)],
      CREATED,
      0,
    );
    assert.deepEqual(tranches.map((tranche) => tranche.remaining_qty), [0, 0]);
  });

  it("never attributes more contracts than the venue reports open", () => {
    const tranches = buildTranches(
      [entry(ENTRY_A, 2, 9001), entry(ENTRY_B, 2, 9002)],
      CREATED,
      3,
    );
    const total = tranches.reduce((sum, tranche) => sum + tranche.remaining_qty, 0);
    assert.equal(total, 3);
  });

  it("keeps the contract with the tranche whose brackets are still working", () => {
    // Targeted partial exit cancels B's brackets and covers one contract; A survives.
    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001, true), entry(ENTRY_B, 1, 9002, false)],
      CREATED,
      1,
    );
    const byIntent = new Map(tranches.map((tranche) => [tranche.intent_id, tranche.remaining_qty]));
    assert.equal(byIntent.get(ENTRY_A), 1);
    assert.equal(byIntent.get(ENTRY_B), 0);
  });

  it("assigns leftover contracts newest first when no brackets are working", () => {
    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001, false), entry(ENTRY_B, 1, 9002, false)],
      CREATED,
      1,
    );
    const byIntent = new Map(tranches.map((tranche) => [tranche.intent_id, tranche.remaining_qty]));
    assert.equal(byIntent.get(ENTRY_B), 1);
    assert.equal(byIntent.get(ENTRY_A), 0);
  });

  it("leaves the contract with the tranche no exit named when every bracket is gone", () => {
    // Auto OCO cancelled both bracket groups on the partial exit of B, so live protection
    // proves nothing; only the exit target says which tranche was meant to close.
    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001, false), entry(ENTRY_B, 1, 9002, false)],
      CREATED,
      1,
      new Set([ENTRY_B]),
    );
    const byIntent = new Map(tranches.map((tranche) => [tranche.intent_id, tranche.remaining_qty]));
    assert.equal(byIntent.get(ENTRY_A), 1);
    assert.equal(byIntent.get(ENTRY_B), 0);
  });

  it("ignores entries that never filled", () => {
    const tranches = buildTranches(
      [entry(ENTRY_A, 0, 9001), entry(ENTRY_B, 1, 9002)],
      CREATED,
      1,
    );
    assert.equal(tranches.length, 1);
    assert.equal(tranches[0]?.intent_id, ENTRY_B);
  });
});
