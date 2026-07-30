import type { ExecutionReceipt } from "./coordinator.js";
import type { StoredExecutionMutation } from "../domain/execution-state.js";
import type { OrderInfo } from "../domain/models.js";
import { bindProtection } from "../ownership/protection.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";

export interface ReceiptReconciliationResult {
  changed: boolean;
  reconciled: number;
}

export function reconcilePendingReceipts(
  store: SqliteExecutionStore,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
  nowUtc: string,
): ReceiptReconciliationResult {
  let changed = false;
  let reconciled = 0;

  for (const intentId of store.pendingReceiptIntentIds()) {
    const receipt = store.receiptForIntent<ExecutionReceipt>(intentId);
    const mutation = store.mutationForIntent(intentId);
    if (!receipt || !mutation) {
      continue;
    }

    const next = reconcileReceipt(receipt, mutation, orders, accountId, contractId, positionOpen);
    if (!next) {
      continue;
    }
    store.recordReceipt({
      ...receipt,
      ...next,
      recorded_utc: nowUtc,
    });
    changed = true;
    reconciled += 1;
  }

  return { changed, reconciled };
}

function reconcileReceipt(
  receipt: ExecutionReceipt,
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
): Partial<ExecutionReceipt> | null {
  if (receipt.code === "entry_submitted_pending_reconciliation" && mutation.operation === "place_order") {
    const intentId = receipt.intent_id;
    if (!intentId || !positionOpen) {
      return null;
    }
    const protection = bindProtection(intentId, orders, accountId, contractId, true);
    if (protection.status !== "proven") {
      return null;
    }
    return {
      status: "open_protected",
      code: "entry_open_with_proven_protection",
      detail: `stop_order_id=${protection.stop.providerOrderId};target_order_id=${protection.target.providerOrderId}`,
    };
  }

  if (mutation.operation !== "modify_order") {
    return null;
  }

  const orderId = mutation.providerOrderId ?? requiredNumber(mutation.request.orderId, "orderId");
  const observed = orders.find((order) => order.id === orderId);
  if (!observed) {
    return null;
  }

  const requestedStop = nullableNumber(mutation.request.stopPrice);
  const requestedLimit = nullableNumber(mutation.request.limitPrice);
  if (requestedStop !== null) {
    if (observed.stopPrice !== requestedStop) {
      return null;
    }
    return {
      status: "submitted",
      code: "move_stop_reconciled",
      detail: `stop_price=${requestedStop}`,
    };
  }
  if (requestedLimit !== null) {
    if (observed.limitPrice !== requestedLimit) {
      return null;
    }
    return {
      status: "submitted",
      code: "move_tp_reconciled",
      detail: `target_price=${requestedLimit}`,
    };
  }
  return null;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`stored_execution_request_invalid:${name}`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
