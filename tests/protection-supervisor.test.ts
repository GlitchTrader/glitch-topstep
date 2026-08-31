import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProtectionHealth } from "../src/execution/protection-supervisor.js";
import { snapshot } from "./fixtures.js";
import type { OrderInfo } from "../src/domain/models.js";

const ACCOUNT_ID = 101;
const CONTRACT_ID = "CON.F.US.MNQ.U26";
const INTENT_ID = "00000000-0000-4000-8000-00000000f001";

test("TS-AUDIT-09 protection supervisor reports zero unprotected on flat healthy snapshot", () => {
  const health = evaluateProtectionHealth({
    snapshot: snapshot(),
    tranches: [],
    activeReduction: null,
    accountId: 101,
    contractId: "CON.F.US.MNQ.U26",
  });
  assert.equal(health.unprotected_open_quantity, 0);
  assert.equal(health.orphan_protective_orders, 0);
});

test("TS-AUDIT31-EX-01 protection supervisor counts a suspended unpriced stop leg as unprotected", () => {
  const suspendedStop: OrderInfo = {
    id: 9701,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-08-31T12:00:08Z",
    updateTimestamp: "2026-08-31T12:00:08Z",
    status: 8,
    type: 4,
    side: 1,
    size: 1,
    limitPrice: null,
    stopPrice: null,
    customTag: `glt-${INTENT_ID}-SL`,
  };
  const health = evaluateProtectionHealth({
    snapshot: {
      ...snapshot(),
      instrumentOpenContracts: 1,
      openOrders: [suspendedStop],
    },
    tranches: [{
      intent_id: INTENT_ID,
      entry_order_id: 9700,
      filled_qty: 1,
      remaining_qty: 1,
      protection: {
        status: "pending",
        reason: "stop_leg_unpriced",
        stop: { provider_order_id: 9701, custom_tag: suspendedStop.customTag ?? "", price: null },
        target: { provider_order_id: null, custom_tag: `glt-${INTENT_ID}-TP`, price: null },
      },
      created_utc: "2026-08-31T12:00:08Z",
    }],
    activeReduction: null,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
  });
  assert.equal(health.unprotected_open_quantity, 1);
});
