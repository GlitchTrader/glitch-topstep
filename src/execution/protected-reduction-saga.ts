import { assertTransition, type StateTransition } from "../domain/state-machines.js";

/**
 * Durable protected reduction states (TS-PROD-01 / #109).
 * Stop coverage must remain >= venue open qty except in explicit degraded_stop_only.
 */
export const PROTECTED_REDUCTION_STATES = [
  "protected_active",
  "reduction_prepared",
  "reduction_submitting",
  "reduction_ambiguous",
  "reduced_protected",
  "degraded_stop_only",
  "flat",
  "failed",
] as const;

export type ProtectedReductionState = (typeof PROTECTED_REDUCTION_STATES)[number];

export const PROTECTED_REDUCTION_TRANSITIONS: Readonly<
  Record<ProtectedReductionState, readonly ProtectedReductionState[]>
> = {
  protected_active: ["reduction_prepared", "flat"],
  reduction_prepared: ["reduction_submitting", "failed", "flat"],
  reduction_submitting: ["reduction_ambiguous", "reduced_protected", "failed", "flat"],
  reduction_ambiguous: ["reduced_protected", "degraded_stop_only", "failed", "flat"],
  reduced_protected: ["degraded_stop_only", "reduction_prepared", "flat"],
  degraded_stop_only: ["reduced_protected", "failed", "flat"],
  flat: [],
  failed: ["flat"],
};

export interface ProtectedReductionRecord {
  reduction_id: string;
  exit_intent_id: string;
  target_intent_id: string | null;
  account_id: number;
  contract_id: string;
  exit_quantity: number;
  position_size_before: number;
  state: ProtectedReductionState;
  provider_exit_order_id: number | null;
  survivor_stop_order_id: number | null;
  survivor_target_order_id: number | null;
  detail: string | null;
  created_utc: string;
  updated_utc: string;
}

export interface ProtectedReductionHealth {
  active_state: ProtectedReductionState | null;
  active_reduction_id: string | null;
  unprotected_open_quantity: number;
  orphan_protective_orders: number;
  ambiguous_age_ms: number | null;
  fail_closed_rollback: boolean;
}

export function transitionProtectedReduction(
  from: ProtectedReductionState | null,
  to: ProtectedReductionState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<ProtectedReductionState> {
  return assertTransition(
    { entity_id: entityId, from, to, occurred_utc: occurredUtc, reason },
    PROTECTED_REDUCTION_TRANSITIONS,
  );
}

/** Rollback switch: restores armed fail-closed without redeploy. */
export function partialExitFailClosedEnabled(): boolean {
  return process.env.GLITCH_PARTIAL_EXIT_FAIL_CLOSED === "1";
}
