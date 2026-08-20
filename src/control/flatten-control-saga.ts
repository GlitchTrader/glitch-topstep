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

/** ponytail: mirrors current service.ts optimistic completion — TS-AUDIT-07 replaces this. */
export function flattenControlPhaseAfterReceipt(
  receiptStatus: string,
  _venue: FlattenVenueSnapshot,
): FlattenControlPhase {
  if (["rejected", "shadowed", "ambiguous"].includes(receiptStatus)) {
    return "manual_intervention_required";
  }
  return "completed";
}

export function flattenControlCanComplete(phase: FlattenControlPhase): boolean {
  return phase === "completed";
}
