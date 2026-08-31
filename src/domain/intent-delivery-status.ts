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

export interface IntentReceiptResponse {
  httpStatus: 200 | 404;
  body: unknown;
}

/**
 * A missing receipt does not mean the intent never happened -- only `not_seen` does. Any other
 * delivery state (registered / mutation_inflight / ambiguous / terminal-without-a-persisted-
 * receipt-object) must still surface as 200 with the delivery-status envelope, so a caller (the
 * Hermes profile) cannot mistake "seen, not yet resolved" for "safe to discard" (TS-REAUDIT-04).
 * A true 404 is reserved for intents this gateway has genuinely never registered.
 */
export function resolveIntentReceiptResponse(
  receipt: unknown,
  deliveryStatus: IntentDeliveryStatusV1,
): IntentReceiptResponse {
  if (receipt !== null && receipt !== undefined) {
    return { httpStatus: 200, body: receipt };
  }
  if (deliveryStatus.status === "not_seen") {
    return { httpStatus: 404, body: { error: "intent_receipt_not_found" } };
  }
  return { httpStatus: 200, body: deliveryStatus };
}
