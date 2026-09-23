import { createHash } from "node:crypto";
import type { DecisionAudit, TradeIntent } from "../domain/models.js";
import { GLITCH_TOPSTEP_OPERATOR_PROFILE, GLITCH_TOPSTEP_PROMPT_VERSION } from "../domain/operator.js";

export function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`stored_execution_request_invalid:${name}`);
  }
  return value;
}

export function deterministicIntentId(namespace: string, ...parts: string[]): string {
  const hex = createHash("sha256")
    .update([namespace, ...parts].join(":"))
    .digest("hex")
    .slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

export function buildSystemExitIntent(input: {
  intentId: string;
  createdUtc: string;
  instrument: string;
  account: string;
  snapshotHash: string;
  modelVersion: string;
  reason: string;
  decisionAudit: DecisionAudit;
}): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: input.intentId,
    createdUtc: input.createdUtc,
    instrument: input.instrument,
    account: input.account,
    operatorProfile: GLITCH_TOPSTEP_OPERATOR_PROFILE,
    action: "EXIT",
    confidence: 1,
    snapshotHash: input.snapshotHash,
    modelVersion: input.modelVersion,
    promptVersion: GLITCH_TOPSTEP_PROMPT_VERSION,
    reason: input.reason,
    decisionAudit: input.decisionAudit,
  };
}
