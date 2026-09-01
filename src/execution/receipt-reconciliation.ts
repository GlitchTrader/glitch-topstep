import {
  BRACKET_VERIFICATION_TIMEOUT_MS,
  resolvePacketProtectionStatus,
  type BracketVerificationEvent,
} from "./bracket-verification.js";
import type { ExecutionReceipt } from "./coordinator.js";
import type { StoredExecutionMutation } from "../domain/execution-state.js";
import type { OrderInfo } from "../domain/models.js";
import { receiptLifecycleFact } from "./lifecycle-facts.js";
import { bindProtection } from "../ownership/protection.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";

const WORKING_ORDER_STATUSES = new Set([0, 1, 6]);

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
  instrumentOpenContracts = 0,
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

    const next = reconcileReceipt(
      store,
      receipt,
      mutation,
      orders,
      accountId,
      contractId,
      positionOpen,
      instrumentOpenContracts,
      nowUtc,
    );
    if (!next) {
      continue;
    }
    const settled: ExecutionReceipt = {
      ...receipt,
      ...next.receipt,
      recorded_utc: nowUtc,
    };
    store.recordReceipt({ ...settled });
    // Reconciliation is where protection, amendments and entry fills become provable, so the
    // lifecycle fact for those moments is published here rather than only at receipt time.
    const fact = receiptLifecycleFact(intentId, settled, nowUtc, {
      submittedUtc: mutation.resolvedUtc ?? mutation.submittingUtc,
      fillObservedUtc: settled.fill_observed_utc ?? null,
      protectionConfirmedUtc: settled.status === "open_protected" ? nowUtc : null,
    });
    store.recordExecutionFact({
      intentId: fact.intentId,
      phase: fact.phase,
      factKey: fact.factKey,
      recordedUtc: fact.recordedUtc,
      detail: fact.detail,
      diagnostics: fact.diagnostics,
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
  store: SqliteExecutionStore,
  receipt: ExecutionReceipt,
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
  instrumentOpenContracts: number,
  nowUtc: string,
): ReconcileReceiptOutcome | null {
  if (
    receipt.code === "partial_exit_submitted_pending_reconciliation"
    && mutation.operation === "place_order"
    && receipt.intent_id
  ) {
    return reconcilePartialExitReceipt(
      store,
      receipt,
      mutation,
      orders,
      accountId,
      contractId,
      positionOpen,
      instrumentOpenContracts,
    );
  }

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

function reconcilePartialExitReceipt(
  store: SqliteExecutionStore,
  receipt: ExecutionReceipt,
  mutation: StoredExecutionMutation,
  orders: OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
  instrumentOpenContracts: number,
): ReconcileReceiptOutcome | null {
  const intentId = receipt.intent_id!;
  const registered = store.registeredIntentPayload(intentId);
  if (registered?.action !== "EXIT") {
    return null;
  }
  const reduction = store.protectedReductionByExitIntent(intentId);
  if (!reduction) {
    return null;
  }
  if (
    reduction.account_id !== accountId
    || reduction.contract_id !== contractId
  ) {
    return null;
  }
  const expectedRemaining = reduction.position_size_before - reduction.exit_quantity;
  if (!positionOpen || expectedRemaining <= 0 || instrumentOpenContracts !== expectedRemaining) {
    return null;
  }
  const exitOrderId = mutation.providerOrderId ?? receipt.order_id ?? null;
  if (exitOrderId === null) {
    return null;
  }
  const scopedOrders = orders.filter(
    (order) => order.accountId === accountId && order.contractId === contractId,
  );
  const exitOrder = scopedOrders.find((order) => order.id === exitOrderId);
  if (exitOrder && WORKING_ORDER_STATUSES.has(exitOrder.status)) {
    return null;
  }
  const requestedSize = nullableNumber(mutation.request.size);
  if (requestedSize !== null && requestedSize !== reduction.exit_quantity) {
    return null;
  }
  return {
    receipt: {
      status: "submitted",
      code: "partial_exit_reconciled_pending_protection",
      detail: `exit_quantity=${reduction.exit_quantity};remaining=${expectedRemaining};provider_order_id=${exitOrderId}`,
    },
    event: null,
  };
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
