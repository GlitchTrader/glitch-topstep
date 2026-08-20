import type { ExecutionMutationState } from "../domain/execution-state.js";
import type {
  ExecutionLedgerPort,
  ExecutionStorePort,
  VenueMutationPort,
} from "../domain/ports/index.js";
import {
  assertTransition,
  EXECUTION_SAGA_TRANSITIONS,
  type ExecutionSagaState,
  type StateTransition,
} from "../domain/state-machines.js";

export interface ExecutionSagaPorts {
  store: ExecutionStorePort;
  ledger: ExecutionLedgerPort;
  venue: VenueMutationPort;
}

export interface ExecutionSagaContext {
  intentId: string;
  state: ExecutionSagaState;
}

const MUTATION_TO_SAGA: Readonly<Record<ExecutionMutationState, ExecutionSagaState>> = {
  prepared: "prepared",
  submitting: "submitting",
  submitted: "submitted",
  confirmed_not_submitted: "rejected",
  rejected: "rejected",
  ambiguous: "ambiguous",
};

export function executionSagaStateFromMutation(
  mutationState: ExecutionMutationState,
): ExecutionSagaState {
  return MUTATION_TO_SAGA[mutationState];
}

export function transitionExecutionSagaState(
  from: ExecutionSagaState | null,
  to: ExecutionSagaState,
  intentId: string,
  reason: string,
  occurredUtc = new Date().toISOString(),
): StateTransition<ExecutionSagaState> {
  return assertTransition(
    { entity_id: intentId, from, to, occurred_utc: occurredUtc, reason },
    EXECUTION_SAGA_TRANSITIONS,
  );
}

export function isTerminalExecutionSagaState(state: ExecutionSagaState): boolean {
  return EXECUTION_SAGA_TRANSITIONS[state].length === 0;
}

export function canAdvanceExecutionSaga(
  from: ExecutionSagaState,
  to: ExecutionSagaState,
): boolean {
  return EXECUTION_SAGA_TRANSITIONS[from].includes(to);
}

export { EXECUTION_SAGA_TRANSITIONS, type ExecutionSagaState };
