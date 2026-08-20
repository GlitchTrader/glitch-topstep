export {
  PROTECTED_REDUCTION_STATES,
  PROTECTED_REDUCTION_TRANSITIONS,
  transitionProtectedReduction,
  partialExitFailClosedEnabled,
  type ProtectedReductionHealth,
  type ProtectedReductionRecord,
  type ProtectedReductionState,
} from "./protected-reduction-saga.js";
export {
  PROTECTION_SAGA_TRANSITIONS,
  transitionProtectionSaga,
  type ProtectionSagaState,
} from "../domain/state-machines.js";

export interface ProtectionSagaContext {
  intentId: string;
  state: import("../domain/state-machines.js").ProtectionSagaState;
}

export interface ProtectionSagaPorts {
  store: import("../domain/ports/execution-store-port.js").ExecutionStorePort;
  venue: import("../domain/ports/venue-mutation-port.js").VenueMutationPort;
}
