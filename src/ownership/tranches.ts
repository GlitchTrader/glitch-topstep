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

function hasLiveProtectiveOrder(entry: EntryOrderOwnership): boolean {
  return entry.protection.stop.providerOrderId !== null
    || entry.protection.target.providerOrderId !== null;
}

/**
 * Distribute the contracts the venue reports as open across the entries that filled.
 *
 * The venue is the only authority on how many contracts are open, so `venueOpenContracts`
 * caps the total and every surplus entry is closed by construction. Live protective orders
 * identify which entries still own those contracts: a targeted partial exit cancels the
 * brackets of the tranche it closes and leaves the survivor's brackets working, so a live
 * stop or target is direct venue evidence of ownership. Entries without live protection
 * absorb whatever is left over, newest first, because exits close oldest first.
 */
export function buildTranches(
  entries: readonly EntryOrderOwnership[],
  intentCreatedUtc: ReadonlyMap<string, string>,
  venueOpenContracts: number,
): TrancheView[] {
  const filledEntries = [...entries]
    .filter((entry) => entry.effectiveFilledQuantity > 0)
    .sort((left, right) => {
      const leftCreated = intentCreatedUtc.get(left.intentId) ?? "";
      const rightCreated = intentCreatedUtc.get(right.intentId) ?? "";
      return leftCreated.localeCompare(rightCreated)
        || left.intentId.localeCompare(right.intentId);
    });

  const claimOrder = [
    ...filledEntries.filter((entry) => hasLiveProtectiveOrder(entry)),
    ...filledEntries.filter((entry) => !hasLiveProtectiveOrder(entry)).reverse(),
  ];

  let unassigned = Math.max(0, venueOpenContracts);
  const remainingByIntent = new Map<string, number>();
  for (const entry of claimOrder) {
    const claimed = Math.min(entry.effectiveFilledQuantity, unassigned);
    remainingByIntent.set(entry.intentId, claimed);
    unassigned -= claimed;
  }

  return filledEntries.map((entry) => ({
    intent_id: entry.intentId,
    entry_order_id: entry.providerOrderId,
    filled_qty: entry.effectiveFilledQuantity,
    remaining_qty: remainingByIntent.get(entry.intentId) ?? 0,
    protection: protectionView(entry.protection),
    created_utc: intentCreatedUtc.get(entry.intentId) ?? "",
  }));
}

export function queryIntentRegistrationTimes(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare(`
    SELECT intent_id, received_utc
    FROM intents
  `).all() as Array<{ intent_id: string; received_utc: string }>;
  return new Map(rows.map((row) => [row.intent_id, row.received_utc]));
}
