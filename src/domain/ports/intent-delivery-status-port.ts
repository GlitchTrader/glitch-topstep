import type { IntentDeliveryStatusV1 } from "../intent-delivery-status.js";

/** TS-REAUDIT-07: port for paired Hermes delivery recovery queries. */
export interface IntentDeliveryStatusPort {
  intentDeliveryStatus(intentId: string): IntentDeliveryStatusV1;
}
