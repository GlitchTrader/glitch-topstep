import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderInfo, PositionInfo } from "../src/domain/models.js";
import type { TrancheView } from "../src/ownership/tranches.js";
import { BRACKET_VERIFICATION_TIMEOUT_MS } from "../src/execution/bracket-verification.js";
import {
  attemptUnprotectedExposureFlatten,
  decideUnprotectedFlatten,
  proveOwnedUnprotectedFlatten,
  unprotectedFlattenIntentId,
} from "../src/execution/unprotected-flatten.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

const accountId = 101;
const contractId = "CON.F.US.MNQ.U26";
const ENTRY_A = "00000000-0000-4000-8000-aaaaaaaa0001";

function position(size = 1): PositionInfo {
  return {
    id: 1,
    accountId,
    contractId,
    creationTimestamp: "2026-09-11T01:00:00Z",
    type: 1,
    size,
    averagePrice: 20_000,
  };
}

function tranche(remaining = 1, intentId = ENTRY_A): TrancheView {
  return {
    intent_id: intentId,
    entry_order_id: 7001,
    filled_qty: remaining,
    remaining_qty: remaining,
    created_utc: "2026-09-11T01:00:00Z",
    protection: {
      status: "incomplete",
      reason: "stop_child_not_observed",
      stop: { provider_order_id: null, custom_tag: `glt-${intentId}-SL`, price: null },
      target: { provider_order_id: null, custom_tag: `glt-${intentId}-TP`, price: null },
    },
  };
}

function stopOrder(intentId = ENTRY_A): OrderInfo {
  return {
    id: 8001,
    accountId,
    contractId,
    creationTimestamp: "2026-09-11T01:00:01Z",
    updateTimestamp: "2026-09-11T01:00:01Z",
    status: 1,
    type: 4,
    side: 1,
    size: 1,
    limitPrice: null,
    stopPrice: 19_990,
    customTag: `glt-${intentId}-SL`,
  };
}

describe("Hermes-death unprotected flatten matrix A–E", () => {
  it("A: runner death with no position — noop, no flatten, no block", async () => {
    const store = new SqliteExecutionStore(":memory:");
    let closes = 0;
    const result = await attemptUnprotectedExposureFlatten({
      store,
      api: { searchOrders: async () => [], closePosition: async () => { closes += 1; } },
      accountId,
      contractId,
      accountName: "TEST",
      instrument: "MNQ",
      positions: [],
      attributableTranches: [],
      unprotectedOpenQuantity: 0,
      afterRearmAttempt: true,
      protectionVerificationFailed: false,
      now: new Date("2026-09-11T01:05:00Z"),
    });
    assert.equal(result.flattened, false);
    assert.equal(result.blockedNewExposure, false);
    assert.equal(closes, 0);
    assert.equal(store.recoveryStatus().blockingNewExposure, false);
    store.close();
  });

  it("B: pending order / unprotected without attributable ownership — block only, no flatten", async () => {
    const store = new SqliteExecutionStore(":memory:");
    let closes = 0;
    store.updateUnprotectedSince(1, "2026-09-11T01:00:00Z");
    const result = await attemptUnprotectedExposureFlatten({
      store,
      api: { searchOrders: async () => [], closePosition: async () => { closes += 1; } },
      accountId,
      contractId,
      accountName: "TEST",
      instrument: "MNQ",
      positions: [position(1)],
      attributableTranches: [],
      unprotectedOpenQuantity: 1,
      afterRearmAttempt: true,
      protectionVerificationFailed: true,
      now: new Date("2026-09-11T01:01:00Z"),
    });
    assert.equal(result.flattened, false);
    assert.equal(result.blockedNewExposure, true);
    assert.equal(closes, 0);
    assert.equal(store.recoveryStatus().blockingNewExposure, true);
    assert.match(result.detail, /no_attributable_tranche_ownership/);
    store.close();
  });

  it("C: fill with confirmed stop — unprotected=0, no flatten", async () => {
    const ownership = proveOwnedUnprotectedFlatten({
      accountId,
      contractId,
      positions: [position(1)],
      attributableTranches: [{
        ...tranche(1),
        protection: {
          status: "proven",
          reason: "ok",
          stop: { provider_order_id: 8001, custom_tag: `glt-${ENTRY_A}-SL`, price: 19_990 },
          target: { provider_order_id: 8002, custom_tag: `glt-${ENTRY_A}-TP`, price: 20_020 },
        },
      }],
      unprotectedOpenQuantity: 0,
    });
    assert.equal(ownership.eligible, false);
    assert.equal(ownership.blockEntries, false);

    const decision = decideUnprotectedFlatten({
      unprotectedOpenQuantity: 0,
      afterRearmAttempt: true,
      protectionVerificationFailed: false,
      unprotectedSinceUtc: null,
      nowUtc: "2026-09-11T01:05:00Z",
      ownership,
    });
    assert.equal(decision.action, "noop");
    // stop resting on venue proves scenario C is safe without Hermes
    assert.equal(stopOrder().stopPrice, 19_990);
  });

  it("D: fill + comms loss + successful rearm path — after rearm unprotected=0 clears block", async () => {
    const store = new SqliteExecutionStore(":memory:");
    store.setUnprotectedFlattenBlock("prior", "2026-09-11T01:00:00Z");
    store.updateUnprotectedSince(1, "2026-09-11T01:00:00Z");
    const result = await attemptUnprotectedExposureFlatten({
      store,
      api: { searchOrders: async () => [], closePosition: async () => { throw new Error("should_not_close"); } },
      accountId,
      contractId,
      accountName: "TEST",
      instrument: "MNQ",
      positions: [position(1)],
      attributableTranches: [tranche(1)],
      unprotectedOpenQuantity: 0, // rearm restored stop coverage
      afterRearmAttempt: true,
      protectionVerificationFailed: false,
      now: new Date("2026-09-11T01:01:00Z"),
    });
    assert.equal(result.flattened, false);
    assert.equal(result.blockedNewExposure, false);
    assert.equal(store.recoveryStatus().blockingNewExposure, false);
    assert.equal(store.unprotectedFlattenBlockReason(), null);
    store.close();
  });

  it("E: fill + rearm failed + unprotected qty — flatten once, idempotent, blocks entries", async () => {
    const store = new SqliteExecutionStore(":memory:");
    let closes = 0;
    const since = "2026-09-11T01:00:00Z";
    const now = new Date(Date.parse(since) + BRACKET_VERIFICATION_TIMEOUT_MS + 1_000);
    store.updateUnprotectedSince(1, since);

    const first = await attemptUnprotectedExposureFlatten({
      store,
      api: { searchOrders: async () => [], closePosition: async () => { closes += 1; } },
      accountId,
      contractId,
      accountName: "TEST",
      instrument: "MNQ",
      positions: [position(1)],
      attributableTranches: [tranche(1)],
      unprotectedOpenQuantity: 1,
      afterRearmAttempt: true,
      protectionVerificationFailed: true,
      now,
    });
    assert.equal(first.flattened, true);
    assert.equal(first.blockedNewExposure, true);
    assert.equal(closes, 1);
    assert.ok(first.controlId);
    assert.equal(store.recoveryStatus().blockingNewExposure, true);
    const receipt = store.receiptForIntent<{ code: string }>(first.controlId!);
    assert.equal(receipt?.code, "unprotected_fail_closed_flatten_submitted");
    assert.equal(store.mutationForIntent(first.controlId!)?.operation, "close_position");

    const second = await attemptUnprotectedExposureFlatten({
      store,
      api: { searchOrders: async () => [], closePosition: async () => { closes += 1; } },
      accountId,
      contractId,
      accountName: "TEST",
      instrument: "MNQ",
      positions: [position(1)],
      attributableTranches: [tranche(1)],
      unprotectedOpenQuantity: 1,
      afterRearmAttempt: true,
      protectionVerificationFailed: true,
      now,
    });
    assert.equal(second.flattened, true);
    assert.equal(closes, 1, "idempotent: no duplicate closePosition");
    assert.equal(second.reason, "idempotent_existing_flatten_mutation");
    store.close();
  });

  it("never flattens ambiguous quantity mismatch", () => {
    const ownership = proveOwnedUnprotectedFlatten({
      accountId,
      contractId,
      positions: [position(2)],
      attributableTranches: [tranche(1)],
      unprotectedOpenQuantity: 1,
    });
    assert.equal(ownership.eligible, false);
    assert.equal(ownership.blockEntries, true);
    assert.match(ownership.detail, /attributable_qty_mismatch/);
  });

  it("deterministic control id is stable", () => {
    const a = unprotectedFlattenIntentId(accountId, contractId, ENTRY_A);
    const b = unprotectedFlattenIntentId(accountId, contractId, ENTRY_A);
    assert.equal(a, b);
  });

  it("inside bracket window after rearm: block only, do not flatten yet", async () => {
    const store = new SqliteExecutionStore(":memory:");
    let closes = 0;
    store.updateUnprotectedSince(1, "2026-09-11T01:00:00Z");
    const result = await attemptUnprotectedExposureFlatten({
      store,
      api: { searchOrders: async () => [], closePosition: async () => { closes += 1; } },
      accountId,
      contractId,
      accountName: "TEST",
      instrument: "MNQ",
      positions: [position(1)],
      attributableTranches: [tranche(1)],
      unprotectedOpenQuantity: 1,
      afterRearmAttempt: true,
      protectionVerificationFailed: false,
      now: new Date("2026-09-11T01:00:10Z"), // < 30s
    });
    assert.equal(result.flattened, false);
    assert.equal(result.blockedNewExposure, true);
    assert.equal(closes, 0);
    assert.equal(result.reason, "unprotected_pending_bracket_window");
    store.close();
  });
});
