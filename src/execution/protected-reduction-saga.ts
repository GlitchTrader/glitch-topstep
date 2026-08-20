import {
  PROTECTED_REDUCTION_STATES,
  PROTECTED_REDUCTION_TRANSITIONS,
  transitionProtectedReduction,
  type ProtectedReductionState,
  type StateTransition,
} from "../domain/state-machines.js";

export {
  PROTECTED_REDUCTION_STATES,
  PROTECTED_REDUCTION_TRANSITIONS,
  transitionProtectedReduction,
  type ProtectedReductionState,
};

/**
 * Durable protected reduction states (TS-PROD-01 / #109).
 * Stop coverage must remain >= venue open qty except in explicit degraded_stop_only.
 */

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

/** Rollback switch: restores armed fail-closed without redeploy. */
export function partialExitFailClosedEnabled(): boolean {
  return process.env.GLITCH_PARTIAL_EXIT_FAIL_CLOSED === "1";
}

export type { StateTransition };
