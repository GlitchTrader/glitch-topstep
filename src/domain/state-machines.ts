export type LifecycleState = "starting" | "ready" | "draining" | "stopped" | "failed_startup" | "failed_shutdown";
export type IntentAdmissionState = "received" | "validated" | "rejected" | "superseded";
export type ExecutionSagaState = "prepared" | "submitting" | "submitted" | "accepted" | "partially_filled" | "filled" | "rejected" | "ambiguous";
export type ProtectionSagaState = "unrequired" | "pending" | "proven" | "stop_only" | "rearming" | "failed";
export type ReconciliationStateMachine = "idle" | "running" | "succeeded" | "failed";
export type OutcomeFeedState = "pending" | "provisional" | "enriched" | "corrected";

export interface StateTransition<TState extends string> {
  entity_id: string;
  from: TState | null;
  to: TState;
  occurred_utc: string;
  reason: string;
}

export function assertTransition<TState extends string>(
  transition: StateTransition<TState>,
  allowed: Readonly<Record<TState, readonly TState[]>>,
): StateTransition<TState> {
  if (transition.from !== null && !allowed[transition.from]?.includes(transition.to)) {
    throw new Error(`invalid_state_transition:${transition.from}:${transition.to}`);
  }
  if (!Number.isFinite(Date.parse(transition.occurred_utc))) {
    throw new Error("state_transition_timestamp_invalid");
  }
  return transition;
}

