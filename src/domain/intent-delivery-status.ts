export type IntentDeliveryState =
  | "not_seen"
  | "registered"
  | "mutation_inflight"
  | "ambiguous"
  | "terminal";

export interface IntentDeliveryStatusV1 {
  schema_version: "glitch.topstep.intent_delivery_status.v1";
  intent_id: string;
  status: IntentDeliveryState;
  receipt_status: string | null;
  mutation_state: string | null;
  retention_generation: 1;
}

export function deriveIntentDeliveryState(input: {
  hasIntent: boolean;
  mutationState: string | null;
  receiptStatus: string | null;
}): IntentDeliveryState {
  if (!input.hasIntent) {
    return "not_seen";
  }
  if (input.receiptStatus) {
    if (input.receiptStatus === "ambiguous") {
      return "ambiguous";
    }
    if (input.receiptStatus === "pending") {
      return input.mutationState === "ambiguous" ? "ambiguous" : "mutation_inflight";
    }
    return "terminal";
  }
  if (input.mutationState) {
    if (input.mutationState === "ambiguous") {
      return "ambiguous";
    }
    if (["prepared", "submitting"].includes(input.mutationState)) {
      return "mutation_inflight";
    }
    return "mutation_inflight";
  }
  return "registered";
}
