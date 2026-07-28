import { createHash } from "node:crypto";
import type { TradeIntent } from "./models.js";

function canonicalIntentPayload(intent: TradeIntent): Record<string, unknown> {
  return {
    schema_version: intent.schemaVersion,
    intent_id: intent.intentId,
    created_utc: intent.createdUtc,
    instrument: intent.instrument,
    account: intent.account,
    operator_profile: intent.operatorProfile,
    action: intent.action,
    confidence: intent.confidence,
    snapshot_hash: intent.snapshotHash,
    model_version: intent.modelVersion,
    prompt_version: intent.promptVersion,
    reason: intent.reason,
    decision_audit: intent.decisionAudit,
    ...(intent.quantity === undefined ? {} : { quantity: intent.quantity }),
    ...(intent.orderType === undefined ? {} : { order_type: intent.orderType }),
    ...(intent.stopLoss === undefined ? {} : { stop_loss: intent.stopLoss }),
    ...(intent.takeProfit1 === undefined ? {} : { take_profit_1: intent.takeProfit1 }),
  };
}

export function computeIntentBodyHash(intent: TradeIntent): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalIntentPayload(intent)))
    .digest("hex");
}
