import type { PositionInfo } from "../domain/models.js";
import { sumInstrumentNetContracts } from "../state/venue-state.js";
import type { TrancheView } from "../ownership/tranches.js";

export type TradeOutcomeFlatTrigger = "reconcile" | "stream";

export function projectedInstrumentOpenContracts(
  positions: readonly PositionInfo[],
  accountId: number,
  contractId: string,
  incoming: PositionInfo,
): number {
  const scoped = positions.filter((position) => position.accountId === accountId);
  const withoutIncoming = scoped.filter((position) => position.id !== incoming.id);
  const next = [...withoutIncoming];
  if (incoming.size !== 0 && incoming.type !== 0) {
    next.push(incoming);
  }
  return sumInstrumentNetContracts(next, contractId);
}

export function tranchesForClosedPosition(tranches: readonly TrancheView[]): TrancheView[] {
  const active = tranches.filter((tranche) => tranche.remaining_qty > 0);
  if (active.length > 0) {
    return [...active];
  }
  return tranches.filter((tranche) => tranche.filled_qty > 0);
}

/**
 * Stream-flat often rebinds ownership after the TP fill removes working brackets.
 * Prefer a previously cached proven tranche over a live pending rebind that lost SL/TP ids.
 */
export function preferRicherClosedTranches(
  live: readonly TrancheView[],
  cached: readonly TrancheView[],
): TrancheView[] {
  if (cached.length === 0) {
    return [...live];
  }
  if (live.length === 0) {
    return [...cached];
  }
  const byIntent = new Map<string, TrancheView>();
  for (const tranche of live) {
    byIntent.set(tranche.intent_id, tranche);
  }
  for (const candidate of cached) {
    const current = byIntent.get(candidate.intent_id);
    if (!current || protectionRichness(candidate) > protectionRichness(current)) {
      byIntent.set(candidate.intent_id, candidate);
    }
  }
  return [...byIntent.values()];
}

function protectionRichness(tranche: TrancheView): number {
  let score = 0;
  if (tranche.protection.status === "proven") {
    score += 100;
  } else if (tranche.protection.status === "pending") {
    score += 10;
  }
  if (tranche.protection.stop.provider_order_id !== null) {
    score += 4;
  }
  if (tranche.protection.target.provider_order_id !== null) {
    score += 4;
  }
  if (tranche.protection.stop.price !== null) {
    score += 1;
  }
  if (tranche.protection.target.price !== null) {
    score += 1;
  }
  return score;
}

export function latchProvenProtectionFromReceipt(
  tranche: TrancheView,
  receipt: { code?: string; detail?: string | null } | null,
  planned: { stop: number | null; target: number | null } = { stop: null, target: null },
): TrancheView {
  const missingStopId = tranche.protection.stop.provider_order_id === null;
  const missingTargetId = tranche.protection.target.provider_order_id === null;
  // Already proven with both bracket ids — nothing to restore.
  if (tranche.protection.status === "proven" && !missingStopId && !missingTargetId) {
    return tranche;
  }
  if (receipt?.code !== "entry_open_with_proven_protection") {
    return tranche;
  }
  const stopOrderId = parseReceiptOrderId(receipt.detail, "stop_order_id");
  const targetOrderId = parseReceiptOrderId(receipt.detail, "target_order_id");
  return {
    ...tranche,
    protection: {
      status: "proven",
      reason: tranche.protection.status === "proven"
        ? tranche.protection.reason
        : "latched_from_open_protected_receipt",
      stop: {
        provider_order_id: stopOrderId ?? tranche.protection.stop.provider_order_id,
        custom_tag: tranche.protection.stop.custom_tag,
        price: tranche.protection.stop.price ?? planned.stop,
      },
      target: {
        provider_order_id: targetOrderId ?? tranche.protection.target.provider_order_id,
        custom_tag: tranche.protection.target.custom_tag,
        price: tranche.protection.target.price ?? planned.target,
      },
    },
  };
}

function parseReceiptOrderId(detail: string | null | undefined, key: string): number | null {
  if (!detail) {
    return null;
  }
  const match = new RegExp(`${key}=(\\d+)`).exec(detail);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

export function shouldPublishTradeOutcomesOnFlat(input: {
  beforeOpen: number;
  afterOpen: number;
  lastReconciledOpenContracts: number;
  tranches: readonly TrancheView[];
}): boolean {
  if (input.afterOpen !== 0 || input.tranches.length === 0) {
    return false;
  }
  return input.beforeOpen > 0 || input.lastReconciledOpenContracts > 0;
}
