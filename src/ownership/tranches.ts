import type { DatabaseSync } from "node:sqlite";
import type { EntryOrderOwnership } from "../domain/order-ownership.js";
import type { EntryProtection } from "../domain/order-ownership.js";

export interface TrancheProtectionView {
  status: EntryProtection["status"];
  reason: string;
  stop: {
    provider_order_id: number | null;
    custom_tag: string;
    price: number | null;
  };
  target: {
    provider_order_id: number | null;
    custom_tag: string;
    price: number | null;
  };
}

export interface TrancheView {
  intent_id: string;
  entry_order_id: number | null;
  filled_qty: number;
  remaining_qty: number;
  protection: TrancheProtectionView;
  created_utc: string;
}

export interface ExitAllocationSource {
  exitIntentId: string;
  quantity: number;
  targetIntentId: string | null;
  createdUtc: string;
}

function protectionView(protection: EntryProtection): TrancheProtectionView {
  return {
    status: protection.status,
    reason: protection.reason,
    stop: {
      provider_order_id: protection.stop.providerOrderId,
      custom_tag: protection.stop.customTag,
      price: protection.stop.price,
    },
    target: {
      provider_order_id: protection.target.providerOrderId,
      custom_tag: protection.target.customTag,
      price: protection.target.price,
    },
  };
}

function trancheEligibleForExit(
  tranche: { intentId: string; createdUtc: string },
  exit: ExitAllocationSource,
): boolean {
  if (!tranche.createdUtc || !exit.createdUtc) {
    return false;
  }
  return tranche.createdUtc.localeCompare(exit.createdUtc) <= 0;
}

function eligibleFifoOrder(
  tranches: ReadonlyArray<{ intentId: string; filledQty: number; createdUtc: string }>,
  exit: ExitAllocationSource,
): Array<{ intentId: string; filledQty: number; createdUtc: string }> {
  return [...tranches]
    .filter((tranche) => trancheEligibleForExit(tranche, exit))
    .sort(
      (left, right) => left.createdUtc.localeCompare(right.createdUtc)
        || left.intentId.localeCompare(right.intentId),
    );
}

export function allocateExitQuantities(
  tranches: ReadonlyArray<{ intentId: string; filledQty: number; createdUtc: string }>,
  exits: ReadonlyArray<ExitAllocationSource>,
): Map<string, number> {
  const remaining = new Map(tranches.map((tranche) => [tranche.intentId, tranche.filledQty]));
  const allocated = new Map<string, number>();
  const sortedExits = [...exits].sort(
    (left, right) => left.createdUtc.localeCompare(right.createdUtc)
      || left.exitIntentId.localeCompare(right.exitIntentId),
  );

  for (const exit of sortedExits) {
    if (exit.targetIntentId !== null) {
      const tranche = tranches.find((candidate) => candidate.intentId === exit.targetIntentId);
      if (!tranche || !trancheEligibleForExit(tranche, exit)) {
        continue;
      }
      const available = remaining.get(exit.targetIntentId) ?? 0;
      const take = Math.min(exit.quantity, available);
      if (take > 0) {
        remaining.set(exit.targetIntentId, available - take);
        allocated.set(
          exit.targetIntentId,
          (allocated.get(exit.targetIntentId) ?? 0) + take,
        );
      }
      continue;
    }

    const fifoOrder = eligibleFifoOrder(tranches, exit);
    let quantityLeft = exit.quantity === Number.MAX_SAFE_INTEGER
      ? fifoOrder.reduce((total, tranche) => total + (remaining.get(tranche.intentId) ?? 0), 0)
      : exit.quantity;

    for (const tranche of fifoOrder) {
      if (quantityLeft <= 0) {
        break;
      }
      const available = remaining.get(tranche.intentId) ?? 0;
      if (available <= 0) {
        continue;
      }
      const take = Math.min(quantityLeft, available);
      remaining.set(tranche.intentId, available - take);
      allocated.set(tranche.intentId, (allocated.get(tranche.intentId) ?? 0) + take);
      quantityLeft -= take;
    }
  }

  return allocated;
}

export function buildTranches(
  entries: readonly EntryOrderOwnership[],
  intentCreatedUtc: ReadonlyMap<string, string>,
  exits: readonly ExitAllocationSource[] = [],
): TrancheView[] {
  const filledEntries = entries.filter((entry) => entry.effectiveFilledQuantity > 0);
  const trancheInputs = filledEntries.map((entry) => ({
    intentId: entry.intentId,
    filledQty: entry.effectiveFilledQuantity,
    createdUtc: intentCreatedUtc.get(entry.intentId) ?? "",
  }));
  const exited = allocateExitQuantities(trancheInputs, exits);

  return filledEntries
    .map((entry) => {
      const createdUtc = intentCreatedUtc.get(entry.intentId) ?? "";
      const filledQty = entry.effectiveFilledQuantity;
      const exitedQty = exited.get(entry.intentId) ?? 0;
      return {
        intent_id: entry.intentId,
        entry_order_id: entry.providerOrderId,
        filled_qty: filledQty,
        remaining_qty: Math.max(0, filledQty - exitedQty),
        protection: protectionView(entry.protection),
        created_utc: createdUtc,
      };
    })
    .sort(
      (left, right) => left.created_utc.localeCompare(right.created_utc)
        || left.intent_id.localeCompare(right.intent_id),
    );
}

export function queryIntentRegistrationTimes(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare(`
    SELECT intent_id, received_utc
    FROM intents
  `).all() as Array<{ intent_id: string; received_utc: string }>;
  return new Map(rows.map((row) => [row.intent_id, row.received_utc]));
}

export function querySubmittedExitAllocations(database: DatabaseSync): ExitAllocationSource[] {
  const rows = database.prepare(`
    SELECT
      intent.intent_id,
      intent.received_utc,
      intent.payload_json,
      outbox.operation,
      outbox.request_json,
      receipt.status
    FROM intents AS intent
    JOIN execution_outbox AS outbox
      ON outbox.intent_id = intent.intent_id
    LEFT JOIN execution_receipts AS receipt
      ON receipt.intent_id = intent.intent_id
    WHERE intent.action = 'EXIT'
      AND outbox.state = 'submitted'
      AND (
        receipt.status IS NULL
        OR receipt.status NOT IN ('rejected', 'ignored')
      )
    ORDER BY intent.received_utc ASC, intent.intent_id ASC
  `).all() as Array<{
    intent_id: string;
    received_utc: string;
    payload_json: string;
    operation: string;
    request_json: string;
    status: string | null;
  }>;

  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const request = JSON.parse(row.request_json) as Record<string, unknown>;
    const targetIntentId = typeof payload.target_intent_id === "string"
      ? payload.target_intent_id
      : typeof payload.targetIntentId === "string"
        ? payload.targetIntentId
        : null;
    let quantity = typeof payload.quantity === "number" && Number.isInteger(payload.quantity)
      ? payload.quantity
      : null;
    if (quantity === null && row.operation === "place_order") {
      const requestSize = typeof request.size === "number" ? request.size : null;
      quantity = requestSize !== null && Number.isInteger(requestSize) ? requestSize : 0;
    }
    if (quantity === null && row.operation === "close_position") {
      quantity = Number.MAX_SAFE_INTEGER;
    }
    return {
      exitIntentId: row.intent_id,
      quantity: quantity ?? 0,
      targetIntentId,
      createdUtc: row.received_utc,
    };
  }).filter((exit) => exit.quantity > 0);
}
