export type LifecycleState = "starting" | "ready" | "draining" | "stopped" | "failed_startup" | "failed_shutdown";
export type IntentAdmissionState = "received" | "validated" | "rejected" | "superseded";
export type ExecutionSagaState = "prepared" | "submitting" | "submitted" | "accepted" | "partially_filled" | "filled" | "rejected" | "ambiguous";
export type ProtectionSagaState = "unrequired" | "pending" | "proven" | "stop_only" | "rearming" | "failed";
export type ReconciliationStateMachine = "idle" | "running" | "succeeded" | "failed";
export type OutcomeFeedState = "pending" | "provisional" | "enriched" | "corrected";

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

export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  stopped: ["starting"],
  starting: ["ready", "failed_startup"],
  ready: ["draining"],
  draining: ["stopped", "failed_shutdown"],
  failed_startup: ["starting", "stopped"],
  failed_shutdown: ["starting"],
};

export const INTENT_ADMISSION_TRANSITIONS: Readonly<
  Record<IntentAdmissionState, readonly IntentAdmissionState[]>
> = {
  received: ["validated", "rejected", "superseded"],
  validated: ["superseded"],
  rejected: [],
  superseded: [],
};

export const EXECUTION_SAGA_TRANSITIONS: Readonly<
  Record<ExecutionSagaState, readonly ExecutionSagaState[]>
> = {
  prepared: ["submitting", "rejected"],
  submitting: ["submitted", "rejected", "ambiguous"],
  submitted: ["accepted", "rejected", "ambiguous"],
  accepted: ["partially_filled", "filled", "rejected", "ambiguous"],
  partially_filled: ["filled", "rejected", "ambiguous"],
  filled: [],
  rejected: [],
  ambiguous: ["accepted", "submitted", "filled", "rejected"],
};

export const PROTECTION_SAGA_TRANSITIONS: Readonly<
  Record<ProtectionSagaState, readonly ProtectionSagaState[]>
> = {
  unrequired: ["pending", "proven"],
  pending: ["proven", "stop_only", "rearming", "failed"],
  proven: ["rearming", "stop_only", "failed", "unrequired"],
  stop_only: ["proven", "rearming", "failed"],
  rearming: ["proven", "stop_only", "failed"],
  failed: ["stop_only", "unrequired", "proven"],
};

export const RECONCILIATION_TRANSITIONS: Readonly<
  Record<ReconciliationStateMachine, readonly ReconciliationStateMachine[]>
> = {
  idle: ["running"],
  running: ["succeeded", "failed"],
  succeeded: ["running", "idle"],
  failed: ["running", "idle"],
};

export const OUTCOME_FEED_TRANSITIONS: Readonly<
  Record<OutcomeFeedState, readonly OutcomeFeedState[]>
> = {
  pending: ["provisional"],
  provisional: ["enriched", "corrected"],
  enriched: ["corrected"],
  corrected: ["corrected"],
};

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

export const TRANSITION_GRAPHS = {
  lifecycle: LIFECYCLE_TRANSITIONS,
  intentAdmission: INTENT_ADMISSION_TRANSITIONS,
  executionSaga: EXECUTION_SAGA_TRANSITIONS,
  protectionSaga: PROTECTION_SAGA_TRANSITIONS,
  reconciliation: RECONCILIATION_TRANSITIONS,
  outcomeFeed: OUTCOME_FEED_TRANSITIONS,
  protectedReduction: PROTECTED_REDUCTION_TRANSITIONS,
} as const;

function transitionEntity<TState extends string>(
  from: TState | null,
  to: TState,
  entityId: string,
  reason: string,
  allowed: Readonly<Record<TState, readonly TState[]>>,
  occurredUtc: string,
): StateTransition<TState> {
  return assertTransition({ entity_id: entityId, from, to, occurred_utc: occurredUtc, reason }, allowed);
}

export function transitionLifecycle(
  from: LifecycleState | null,
  to: LifecycleState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<LifecycleState> {
  return transitionEntity(from, to, entityId, reason, LIFECYCLE_TRANSITIONS, occurredUtc);
}

export function transitionIntentAdmission(
  from: IntentAdmissionState | null,
  to: IntentAdmissionState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<IntentAdmissionState> {
  return transitionEntity(from, to, entityId, reason, INTENT_ADMISSION_TRANSITIONS, occurredUtc);
}

export function transitionExecutionSaga(
  from: ExecutionSagaState | null,
  to: ExecutionSagaState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<ExecutionSagaState> {
  return transitionEntity(from, to, entityId, reason, EXECUTION_SAGA_TRANSITIONS, occurredUtc);
}

export function transitionProtectionSaga(
  from: ProtectionSagaState | null,
  to: ProtectionSagaState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<ProtectionSagaState> {
  return transitionEntity(from, to, entityId, reason, PROTECTION_SAGA_TRANSITIONS, occurredUtc);
}

export function transitionReconciliation(
  from: ReconciliationStateMachine | null,
  to: ReconciliationStateMachine,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<ReconciliationStateMachine> {
  return transitionEntity(from, to, entityId, reason, RECONCILIATION_TRANSITIONS, occurredUtc);
}

export function transitionOutcomeFeed(
  from: OutcomeFeedState | null,
  to: OutcomeFeedState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<OutcomeFeedState> {
  return transitionEntity(from, to, entityId, reason, OUTCOME_FEED_TRANSITIONS, occurredUtc);
}

export function transitionProtectedReduction(
  from: ProtectedReductionState | null,
  to: ProtectedReductionState,
  entityId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<ProtectedReductionState> {
  return transitionEntity(from, to, entityId, reason, PROTECTED_REDUCTION_TRANSITIONS, occurredUtc);
}
