export type ExecutionOperation = "place_order" | "close_position" | "no_mutation";

export type ExecutionMutationState =
  | "prepared"
  | "submitting"
  | "submitted"
  | "confirmed_not_submitted"
  | "rejected"
  | "ambiguous";

export interface StoredExecutionMutation {
  intentId: string;
  operation: Exclude<ExecutionOperation, "no_mutation">;
  state: ExecutionMutationState;
  customTag: string | null;
  request: Record<string, unknown>;
  createdUtc: string;
  submittingUtc: string | null;
  resolvedUtc: string | null;
  providerOrderId: number | null;
  lastError: string | null;
}

export interface StoredIntentWithoutExecution {
  intentId: string;
  action: string;
  receivedUtc: string;
}

export interface RecoveredExecutionResolution {
  intentId: string;
  operation: ExecutionOperation;
  outcome: "submitted" | "confirmed_not_submitted" | "rejected" | "ambiguous";
  code: string;
  providerOrderId: number | null;
  detail: string | null;
}

export interface ExecutionRecoveryStatus {
  blockingAmbiguity: boolean;
  unresolvedMutations: number;
  ambiguousMutations: number;
  lastRecoveryUtc: string | null;
  lastRecoveryError: string | null;
}
