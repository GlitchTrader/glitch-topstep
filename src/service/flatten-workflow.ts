import type { AccountVenueSnapshot } from "../domain/models.js";
import {
  flattenControlCanComplete,
  flattenControlPhaseAfterReceipt,
  type FlattenVenueSnapshot,
} from "../control/flatten-control-saga.js";

export type FlattenControlTerminalStatus = "completed" | "applying" | "failed";

export interface FlattenControlTransition {
  status: FlattenControlTerminalStatus;
  detail: string;
}

export function buildFlattenVenueSnapshot(
  snapshot: AccountVenueSnapshot,
  accountId: number,
  contractId: string,
): FlattenVenueSnapshot {
  const ownWorkingOrders = snapshot.openOrders.filter(
    (order) => order.accountId === accountId && order.contractId === contractId,
  ).length;
  return {
    instrumentOpenContracts: snapshot.instrumentOpenContracts,
    ownWorkingOrders,
    stateComplete: snapshot.stateComplete,
  };
}

export function resolveFlattenAfterReceipt(
  receiptStatus: string,
  venue: FlattenVenueSnapshot,
): FlattenControlTransition {
  const phase = flattenControlPhaseAfterReceipt(receiptStatus, venue);
  if (flattenControlCanComplete(phase)) {
    return { status: "completed", detail: "venue_flat_confirmed" };
  }
  return { status: "applying", detail: "waiting_for_flat" };
}

export function resolveFlattenAfterRestart(
  controlDetail: string | null,
  venue: FlattenVenueSnapshot,
): FlattenControlTransition {
  const phase = flattenControlPhaseAfterReceipt("submitted", venue);
  if (flattenControlCanComplete(phase)) {
    return { status: "completed", detail: "reconciled_already_flat_after_restart" };
  }
  if (controlDetail === "waiting_for_flat") {
    return { status: "applying", detail: "waiting_for_flat" };
  }
  return {
    status: "failed",
    detail: "flatten_application_ambiguous_requires_operator_reconciliation",
  };
}

export function shouldCompletePendingFlatten(venue: FlattenVenueSnapshot): boolean {
  return flattenControlCanComplete(flattenControlPhaseAfterReceipt("submitted", venue));
}
