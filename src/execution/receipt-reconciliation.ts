import {
  BRACKET_VERIFICATION_TIMEOUT_MS,
  resolvePacketProtectionStatus,
  type BracketVerificationEvent,
} from "./bracket-verification.js";
import type { ExecutionReceipt } from "./coordinator.js";
import type { StoredExecutionMutation } from "../domain/execution-state.js";
import type { OrderInfo } from "../domain/models.js";
import { bindProtection } from "../ownership/protection.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";

export interface ReceiptReconciliationResult {
  changed: boolean;
  reconciled: number;
  events: BracketVerificationEvent[];
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
  const events: BracketVerificationEvent[] = [];

  for (const intentId of store.pendingReceiptIntentIds()) {
    const receipt = store.receiptForIntent<ExecutionReceipt>(intentId);
    const mutation = store.mutationForIntent(intentId);
    if (!receipt || !mutation) {
      continue;
    }

    const next = reconcileReceipt(receipt, mutation, orders, accountId, contractId, positionOpen, nowUtc);
    if (!next) {
      continue;
    }
    store.recordReceipt({
      ...receipt,
      ...next.receipt,
      recorded_utc: nowUtc,
    });
    changed = true;
    reconciled += 1;
    if (next.event) {
      events.push(next.event);
    }
  }

  return { changed, reconciled, events };
}

interface ReconcileReceiptOutcome {
  receipt: Partial<ExecutionReceipt>;
  event: BracketVerificationEvent | null;
}

function reconcileReceipt(
  receipt: ExecutionReceipt,
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
  nowUtc: string,
): ReconcileReceiptOutcome | null {
  if (
    (receipt.code === "entry_submitted_pending_reconciliation"
      || receipt.code === "entry_protection_verification_failed")
    && mutation.operation === "place_order"
  ) {
    const intentId = receipt.intent_id;
    if (!intentId || !positionOpen) {
      return null;
    }
    const fillObservedUtc = receipt.fill_observed_utc ?? nowUtc;
    const protection = bindProtection(
      intentId,
      orders,
      accountId,
      contractId,
      true,
      receipt.order_id ?? null,
    );
    if (protection.status === "proven") {
      return {
        receipt: {
          status: "open_protected",
          code: "entry_open_with_proven_protection",
          detail: `stop_order_id=${protection.stop.providerOrderId};target_order_id=${protection.target.providerOrderId}`,
          fill_observed_utc: fillObservedUtc,
        },
        event: {
          event: "bracket_verification_confirmed",
          intent_id: intentId,
          protection_status: "confirmed",
          reason: "sl_tp_verified_on_venue",
          elapsed_ms: resolvePacketProtectionStatus({
            positionOpen: true,
            internalStatus: "proven",
            fillObservedUtc,
            stateComplete: true,
            nowUtc,
          }).elapsed_ms,
        },
      };
    }

    const verification = resolvePacketProtectionStatus({
      positionOpen: true,
      internalStatus: protection.status,
      fillObservedUtc,
      stateComplete: true,
      nowUtc,
      timeoutMs: BRACKET_VERIFICATION_TIMEOUT_MS,
    });
    if (verification.protection_status === "failed" && receipt.code !== "entry_protection_verification_failed") {
      return {
        receipt: {
          code: "entry_protection_verification_failed",
          detail: `${protection.reason};timeout_ms=${BRACKET_VERIFICATION_TIMEOUT_MS}`,
          fill_observed_utc: fillObservedUtc,
        },
        event: {
          event: "bracket_verification_failed",
          intent_id: intentId,
          protection_status: "failed",
          reason: verification.reason,
          elapsed_ms: verification.elapsed_ms,
        },
      };
    }
    if (!receipt.fill_observed_utc) {
      return {
        receipt: { fill_observed_utc: fillObservedUtc },
        event: null,
      };
    }
    return null;
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
      receipt: {
        status: "submitted",
        code: "move_stop_reconciled",
        detail: `stop_price=${requestedStop}`,
      },
      event: null,
    };
  }
  if (requestedLimit !== null) {
    if (observed.limitPrice !== requestedLimit) {
      return null;
    }
    return {
      receipt: {
        status: "submitted",
        code: "move_tp_reconciled",
        detail: `target_price=${requestedLimit}`,
      },
      event: null,
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
