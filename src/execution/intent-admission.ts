import { parseTradeIntent, IntentParseError } from "../domain/intents.js";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { TradeIntent, TradingMode } from "../domain/models.js";
import type { ExecutionLedgerStatus } from "../domain/ports/execution-ledger-port.js";
import type { IntentRegistrationResult } from "../domain/ports/execution-store-port.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import { admissionDiagnostics } from "./lifecycle-facts.js";
import { maybeKill } from "./kill-hook.js";

export type IntentAdmissionHandoffAction = "EXIT" | "MOVE_STOP" | "MOVE_TP";

export interface IntentAdmissionReceiptParams {
  intentId: string | null;
  status: "rejected" | "ignored" | "ambiguous";
  code: string;
  detail?: string;
  field?: string;
  error?: string;
  path?: string;
}

export type IntentAdmissionEarlyResult =
  | { kind: "reject"; receipt: IntentAdmissionReceiptParams }
  | { kind: "ignore"; receipt: IntentAdmissionReceiptParams }
  | { kind: "ambiguous"; receipt: IntentAdmissionReceiptParams }
  | {
    kind: "handoff";
    intent: TradeIntent;
    issuedPacket: DirectDecisionPacket;
    action: IntentAdmissionHandoffAction;
  }
  | { kind: "proceed"; intent: TradeIntent; issuedPacket: DirectDecisionPacket };

export interface IntentAdmissionEarlyDeps {
  registerIntent(intent: TradeIntent, receivedUtc: string): IntentRegistrationResult;
  receiptForIntent<T = Record<string, unknown>>(intentId: string): T | null;
  recordExecutionFact(input: {
    intentId: string;
    phase: string;
    recordedUtc: string;
    detail: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  }): void;
  resolveIssuedPacket(snapshotHash: string): DirectDecisionPacket | null;
  currentMode(): TradingMode;
  controlPaused(): boolean;
  ledgerIsDurable(): boolean;
  ledgerStatus(): ExecutionLedgerStatus;
  recoveryStatus(): ExecutionRecoveryStatus;
  receivedUtc?: string;
}

/**
 * Parse, register, and early gates for wire intents through the recovery block
 * (before validateEntryRisk). Side effects on the store happen here; receipt
 * persistence remains with the coordinator.
 */
export function evaluateIntentAdmissionEarly(
  input: unknown,
  deps: IntentAdmissionEarlyDeps,
): IntentAdmissionEarlyResult {
  let intent: TradeIntent;
  try {
    intent = parseTradeIntent(input);
  } catch (error) {
    if (error instanceof IntentParseError) {
      return {
        kind: "reject",
        receipt: {
          intentId: null,
          status: "rejected",
          code: "intent_schema_invalid",
          detail: error.message,
          field: error.field,
          error: error.errorCode,
          path: error.path,
        },
      };
    }
    return {
      kind: "reject",
      receipt: {
        intentId: null,
        status: "rejected",
        code: "intent_schema_invalid",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const receivedUtc = deps.receivedUtc ?? new Date().toISOString();
  const registration = deps.registerIntent(intent, receivedUtc);
  if (registration.status === "conflict") {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "intent_body_conflict",
        detail: "The same intent_id was already registered with a different body hash.",
      },
    };
  }
  if (registration.status === "duplicate") {
    return {
      kind: "ambiguous",
      receipt: {
        intentId: intent.intentId,
        status: "ambiguous",
        code: "intent_already_processing_or_recovery_required",
      },
    };
  }

  deps.recordExecutionFact({
    intentId: intent.intentId,
    phase: "intent_admitted",
    recordedUtc: receivedUtc,
    detail: {
      action: intent.action,
      decision_latency_ms: Math.max(0, Date.parse(receivedUtc) - Date.parse(intent.createdUtc)),
    },
    diagnostics: admissionDiagnostics(intent.createdUtc, receivedUtc) as unknown as Record<string, unknown>,
  });

  maybeKill("after_intent_before_outbox");

  const issuedPacket = intent.action === "NOTHING" || intent.action === "HOLD"
    ? null
    : deps.resolveIssuedPacket(intent.snapshotHash);
  if (issuedPacket === null && intent.action !== "NOTHING" && intent.action !== "HOLD") {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "decision_packet_unknown_or_expired",
      },
    };
  }

  if (deps.currentMode() === "disabled") {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "trading_disabled_by_operator",
      },
    };
  }

  if (intent.action === "NOTHING" || intent.action === "HOLD") {
    return {
      kind: "ignore",
      receipt: {
        intentId: intent.intentId,
        status: "ignored",
        code: "no_execution_action",
      },
    };
  }

  if (!issuedPacket) {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "decision_packet_unknown_or_expired",
      },
    };
  }

  if (intent.action === "EXIT") {
    return { kind: "handoff", intent, issuedPacket, action: "EXIT" };
  }
  if (intent.action === "MOVE_STOP") {
    return { kind: "handoff", intent, issuedPacket, action: "MOVE_STOP" };
  }
  if (intent.action === "MOVE_TP") {
    return { kind: "handoff", intent, issuedPacket, action: "MOVE_TP" };
  }

  if (intent.action !== "ENTER_LONG" && intent.action !== "ENTER_SHORT") {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "action_not_implemented",
        detail: `Unsupported action: ${intent.action}`,
      },
    };
  }

  if (deps.controlPaused()) {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "new_exposure_paused_by_operator",
      },
    };
  }

  if (!deps.ledgerIsDurable()) {
    const ledger = deps.ledgerStatus();
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: "execution_evidence_persistence_degraded",
        detail: `The execution evidence ledger has ${ledger.consecutive_failures} consecutive failed writes; new exposure is blocked until an append is durable.`,
        ...(ledger.last_write_error === null ? {} : { error: ledger.last_write_error }),
      },
    };
  }

  const recovery = deps.recoveryStatus();
  if (recovery.blockingNewExposure) {
    return {
      kind: "reject",
      receipt: {
        intentId: intent.intentId,
        status: "rejected",
        code: recovery.blockingAmbiguity
          ? "execution_recovery_required"
          : "entry_submission_pending",
        detail: recovery.blockingAmbiguity
          ? "A prior ProjectX mutation remains ambiguous; new exposure is blocked until provider reconciliation proves its outcome."
          : "A prior entry submission has not yet appeared in authoritative ProjectX order or position state.",
      },
    };
  }

  return { kind: "proceed", intent, issuedPacket };
}
