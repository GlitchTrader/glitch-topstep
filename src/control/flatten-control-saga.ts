export type FlattenControlPhase =
  | "requested"
  | "submitted"
  | "waiting_for_flat"
  | "venue_flat_confirmed"
  | "completed"
  | "manual_intervention_required";

export interface FlattenVenueSnapshot {
  instrumentOpenContracts: number;
  ownWorkingOrders: number;
  stateComplete: boolean;
}

export function flattenControlPhaseAfterReceipt(
  receiptStatus: string,
  venue: FlattenVenueSnapshot,
): FlattenControlPhase {
  if (["rejected", "shadowed", "ambiguous"].includes(receiptStatus)) {
    return "manual_intervention_required";
  }
  if (
    venue.instrumentOpenContracts === 0
    && venue.ownWorkingOrders === 0
    && venue.stateComplete
  ) {
    return "completed";
  }
  if (
    receiptStatus === "submitted"
    || receiptStatus === "accepted"
    || receiptStatus === "open_protected"
  ) {
    return "waiting_for_flat";
  }
  return venue.instrumentOpenContracts === 0
    && venue.ownWorkingOrders === 0
    && venue.stateComplete
    ? "completed"
    : "waiting_for_flat";
}

export function flattenControlCanComplete(phase: FlattenControlPhase): boolean {
  return phase === "completed";
}
