import assert from "node:assert/strict";
import test from "node:test";
import type { PositionInfo } from "../src/domain/models.js";
import {
  latchProvenProtectionFromReceipt,
  preferRicherClosedTranches,
  projectedInstrumentOpenContracts,
  shouldPublishTradeOutcomesOnFlat,
  tranchesForClosedPosition,
} from "../src/learning/trade-outcome-flat.js";
import type { TrancheView } from "../src/ownership/tranches.js";

const tranche = (remainingQty: number): TrancheView => ({
  intent_id: "774b92f8-61a2-5c3a-b68e-e7f722bf1cf0",
  entry_order_id: 1,
  filled_qty: 1,
  remaining_qty: remainingQty,
  created_utc: "2026-08-03T13:57:08.000Z",
  protection: {
    status: "proven",
    reason: "ok",
    stop: { provider_order_id: 1, custom_tag: "stop", price: 1 },
    target: { provider_order_id: 2, custom_tag: "target", price: 2 },
  },
});

const openLong: PositionInfo = {
  id: 1,
  accountId: 101,
  contractId: "CON.F.US.MNQ.U26",
  creationTimestamp: "2026-08-03T13:57:08.000Z",
  type: 1,
  size: 1,
  averagePrice: 20_000,
};

test("projectedInstrumentOpenContracts marks flat when stream zeroes the scoped leg", () => {
  const flatUpdate: PositionInfo = { ...openLong, size: 0, type: 0 };
  const after = projectedInstrumentOpenContracts(
    [openLong],
    101,
    "CON.F.US.MNQ.U26",
    flatUpdate,
  );
  assert.equal(after, 0);
});

test("shouldPublishTradeOutcomesOnFlat accepts reconcile fallback after stream pre-flattened state", () => {
  assert.equal(shouldPublishTradeOutcomesOnFlat({
    beforeOpen: 0,
    afterOpen: 0,
    lastReconciledOpenContracts: 1,
    tranches: [tranche(0)],
  }), true);
});

test("shouldPublishTradeOutcomesOnFlat rejects when still open or no tranches", () => {
  assert.equal(shouldPublishTradeOutcomesOnFlat({
    beforeOpen: 1,
    afterOpen: 1,
    lastReconciledOpenContracts: 1,
    tranches: [tranche(1)],
  }), false);
  assert.equal(shouldPublishTradeOutcomesOnFlat({
    beforeOpen: 1,
    afterOpen: 0,
    lastReconciledOpenContracts: 1,
    tranches: [],
  }), false);
});

test("tranchesForClosedPosition prefers active tranches then falls back to filled history", () => {
  assert.deepEqual(
    tranchesForClosedPosition([tranche(1), tranche(0)]),
    [tranche(1)],
  );
  assert.deepEqual(
    tranchesForClosedPosition([tranche(0)]),
    [tranche(0)],
  );
});

test("preferRicherClosedTranches keeps cached proven protection over live pending rebind", () => {
  const livePending: TrancheView = {
    ...tranche(1),
    protection: {
      status: "pending",
      reason: "target_child_not_observed",
      stop: { provider_order_id: 1, custom_tag: "stop", price: 29576.25 },
      target: { provider_order_id: null, custom_tag: "target", price: null },
    },
  };
  const cachedProven = tranche(1);
  const merged = preferRicherClosedTranches([livePending], [cachedProven]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.protection.status, "proven");
  assert.equal(merged[0]?.protection.target.provider_order_id, 2);
});

test("latchProvenProtectionFromReceipt restores SL/TP ids after Auto OCO flat", () => {
  const pending: TrancheView = {
    ...tranche(0),
    protection: {
      status: "pending",
      reason: "target_child_not_observed",
      stop: { provider_order_id: null, custom_tag: "stop", price: 29576.25 },
      target: { provider_order_id: null, custom_tag: "target", price: null },
    },
  };
  const latched = latchProvenProtectionFromReceipt(
    pending,
    {
      code: "entry_open_with_proven_protection",
      detail: "stop_order_id=3375341459;target_order_id=3375341460",
    },
    { stop: 29576.5, target: 29594.5 },
  );
  assert.equal(latched.protection.status, "proven");
  assert.equal(latched.protection.stop.provider_order_id, 3375341459);
  assert.equal(latched.protection.target.provider_order_id, 3375341460);
  assert.equal(latched.protection.target.price, 29594.5);
});
