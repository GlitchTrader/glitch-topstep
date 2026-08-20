import type { ExecutionRecoveryStatus } from "../execution-state.js";
import type { TradeIntent } from "../models.js";

export type IntentRegistrationResult =
  | { status: "claimed" }
  | { status: "duplicate" }
  | { status: "conflict" };

export interface ExecutionFactInput {
  intentId: string;
  phase: string;
  factKey?: string;
  recordedUtc: string;
  detail: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

/** Subset of execution persistence used by admission, sagas, and reconciliation. */
export interface ExecutionStorePort {
  registerIntent(intent: TradeIntent, receivedUtc: string): IntentRegistrationResult;
  receiptForIntent<T = Record<string, unknown>>(intentId: string): T | null;
  recordExecutionFact(input: ExecutionFactInput): void;
  recordReceipt(receipt: Record<string, unknown>): void;
  recoveryStatus(): ExecutionRecoveryStatus;
  terminalMutationsWithoutReceipts(): readonly { intentId: string }[];
  intentsWithoutReceiptsOrMutations(): readonly { intentId: string }[];
}
