import { createHash, randomUUID } from "node:crypto";
import type { AccountVenueSnapshot, OrderInfo, PositionInfo, TradeIntent } from "../domain/models.js";
import { GLITCH_TOPSTEP_OPERATOR_PROFILE, GLITCH_TOPSTEP_PROMPT_VERSION } from "../domain/operator.js";
import { bindProtection } from "../ownership/protection.js";
import type { TrancheView } from "../ownership/tranches.js";
import type { JsonlEventStore } from "../storage/jsonl-event-store.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import {
  BRACKET_VERIFICATION_TIMEOUT_MS,
  resolvePacketProtectionStatus,
} from "./bracket-verification.js";
import type { ProtectedReductionRecord } from "./protected-reduction-saga.js";
import { evaluateProtectionHealth } from "./protection-supervisor.js";
import type { ExecutionRecoveryApi } from "./recovery.js";

export type UnprotectedFlattenTrigger =
  | "protection_status_failed"
  | "rearm_exhausted";

export interface UnprotectedFlattenOwnershipInput {
  accountId: number;
  contractId: string;
  positions: readonly PositionInfo[];
  attributableTranches: readonly TrancheView[];
  unprotectedOpenQuantity: number;
}

export type UnprotectedFlattenOwnership =
  | {
      eligible: true;
      quantity: number;
      entryIntentIds: string[];
      detail: string;
    }
  | {
      eligible: false;
      blockEntries: boolean;
      detail: string;
    };

export interface UnprotectedFlattenDecision {
  action: "noop" | "block_only" | "flatten";
  trigger: UnprotectedFlattenTrigger | null;
  reason: string;
  ownership: UnprotectedFlattenOwnership | null;
}

export interface UnprotectedFlattenResult {
  changed: boolean;
  flattened: boolean;
  blockedNewExposure: boolean;
  controlId: string | null;
  trigger: UnprotectedFlattenTrigger | null;
  reason: string;
  detail: string;
}

/** Deterministic EXIT intent for fail-closed unprotected flatten (idempotent). */
export function unprotectedFlattenIntentId(
  accountId: number,
  contractId: string,
  entryIntentKey: string,
): string {
  const hex = createHash("sha256")
    .update(`unprotected-fail-closed-flatten:${accountId}:${contractId}:${entryIntentKey}`)
    .digest("hex")
    .slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Fail-closed ownership: one scoped open position whose size equals attributable remaining qty.
 * Ambiguous identity never flattens; still blocks new entries when unprotected qty > 0.
 */
export function proveOwnedUnprotectedFlatten(
  input: UnprotectedFlattenOwnershipInput,
): UnprotectedFlattenOwnership {
  if (input.unprotectedOpenQuantity <= 0) {
    return { eligible: false, blockEntries: false, detail: "no_unprotected_quantity" };
  }

  const scoped = input.positions.filter(
    (position) => position.accountId === input.accountId
      && position.contractId === input.contractId
      && position.type !== 0
      && Math.abs(position.size) > 0,
  );
  if (scoped.length === 0) {
    return { eligible: false, blockEntries: true, detail: "unprotected_without_scoped_position" };
  }
  if (scoped.length > 1) {
    return { eligible: false, blockEntries: true, detail: "ambiguous_position_rows" };
  }

  const position = scoped[0]!;
  const quantity = Math.abs(position.size);
  if (input.unprotectedOpenQuantity > quantity) {
    return { eligible: false, blockEntries: true, detail: "unprotected_qty_exceeds_position" };
  }

  const liveTranches = input.attributableTranches.filter((tranche) => tranche.remaining_qty > 0);
  if (liveTranches.length === 0) {
    return { eligible: false, blockEntries: true, detail: "no_attributable_tranche_ownership" };
  }

  const attributableQty = liveTranches.reduce((sum, tranche) => sum + tranche.remaining_qty, 0);
  if (attributableQty !== quantity) {
    return {
      eligible: false,
      blockEntries: true,
      detail: `attributable_qty_mismatch:attributable=${attributableQty};position=${quantity}`,
    };
  }

  const entryIntentIds = liveTranches.map((tranche) => tranche.intent_id).sort();
  return {
    eligible: true,
    quantity,
    entryIntentIds,
    detail: `owned_tranches=${entryIntentIds.join(",")};qty=${quantity};unprotected=${input.unprotectedOpenQuantity}`,
  };
}

export function decideUnprotectedFlatten(input: {
  unprotectedOpenQuantity: number;
  afterRearmAttempt: boolean;
  protectionVerificationFailed: boolean;
  unprotectedSinceUtc: string | null;
  nowUtc: string;
  ownership: UnprotectedFlattenOwnership;
}): UnprotectedFlattenDecision {
  if (input.unprotectedOpenQuantity <= 0) {
    return {
      action: "noop",
      trigger: null,
      reason: "protected_or_flat",
      ownership: input.ownership,
    };
  }

  const timedOut = unprotectedTimedOut(input.unprotectedSinceUtc, input.nowUtc);
  const trigger: UnprotectedFlattenTrigger | null = input.protectionVerificationFailed
    ? "protection_status_failed"
    : timedOut
      ? "rearm_exhausted"
      : null;

  if (!input.ownership.eligible) {
    return {
      action: "block_only",
      trigger,
      reason: input.ownership.detail,
      ownership: input.ownership,
    };
  }

  if (
    input.afterRearmAttempt
    && (input.protectionVerificationFailed || timedOut)
  ) {
    return {
      action: "flatten",
      trigger: input.protectionVerificationFailed
        ? "protection_status_failed"
        : "rearm_exhausted",
      reason: input.protectionVerificationFailed
        ? "protection_failed_after_rearm"
        : "unprotected_after_rearm_and_verification_timeout",
      ownership: input.ownership,
    };
  }

  return {
    action: "block_only",
    trigger,
    reason: input.afterRearmAttempt
      ? "unprotected_pending_bracket_window"
      : "awaiting_rearm_or_verification_timeout",
    ownership: input.ownership,
  };
}

export function anyProtectionVerificationFailed(input: {
  tranches: readonly TrancheView[];
  openOrders: readonly OrderInfo[];
  accountId: number;
  contractId: string;
  positionOpen: boolean;
  nowUtc: string;
  receiptForIntent: (intentId: string) => { code?: string; fill_observed_utc?: string } | null;
}): boolean {
  return input.tranches.some((tranche) => {
    const receipt = input.receiptForIntent(tranche.intent_id);
    if (receipt?.code === "entry_protection_verification_failed") {
      return true;
    }
    const protection = bindProtection(
      tranche.intent_id,
      input.openOrders,
      input.accountId,
      input.contractId,
      input.positionOpen,
      tranche.entry_order_id,
    );
    const packetStatus = resolvePacketProtectionStatus({
      positionOpen: input.positionOpen,
      internalStatus: protection.status,
      fillObservedUtc: receipt?.fill_observed_utc ?? tranche.created_utc,
      stateComplete: true,
      nowUtc: input.nowUtc,
      timeoutMs: BRACKET_VERIFICATION_TIMEOUT_MS,
    });
    return packetStatus.protection_status === "failed";
  });
}

export async function attemptUnprotectedExposureFlatten(input: {
  store: SqliteExecutionStore;
  api: ExecutionRecoveryApi;
  accountId: number;
  contractId: string;
  accountName: string;
  instrument: string;
  positions: readonly PositionInfo[];
  attributableTranches: readonly TrancheView[];
  unprotectedOpenQuantity: number;
  afterRearmAttempt: boolean;
  protectionVerificationFailed: boolean;
  now?: Date;
}): Promise<UnprotectedFlattenResult> {
  const now = input.now ?? new Date();
  const nowUtc = now.toISOString();

  if (input.unprotectedOpenQuantity <= 0) {
    input.store.clearUnprotectedFlattenBlock();
    return {
      changed: false,
      flattened: false,
      blockedNewExposure: false,
      controlId: null,
      trigger: null,
      reason: "protected_or_flat",
      detail: "cleared",
    };
  }

  input.store.setUnprotectedFlattenBlock("unprotected_open_quantity", nowUtc);

  const ownership = proveOwnedUnprotectedFlatten({
    accountId: input.accountId,
    contractId: input.contractId,
    positions: input.positions,
    attributableTranches: input.attributableTranches,
    unprotectedOpenQuantity: input.unprotectedOpenQuantity,
  });

  const decision = decideUnprotectedFlatten({
    unprotectedOpenQuantity: input.unprotectedOpenQuantity,
    afterRearmAttempt: input.afterRearmAttempt,
    protectionVerificationFailed: input.protectionVerificationFailed,
    unprotectedSinceUtc: input.store.unprotectedSinceUtc(),
    nowUtc,
    ownership,
  });

  if (decision.action !== "flatten" || !ownership.eligible) {
    return {
      changed: decision.action === "block_only",
      flattened: false,
      blockedNewExposure: true,
      controlId: null,
      trigger: decision.trigger,
      reason: decision.reason,
      detail: ownership.eligible ? decision.reason : ownership.detail,
    };
  }

  if (typeof input.api.closePosition !== "function") {
    return {
      changed: true,
      flattened: false,
      blockedNewExposure: true,
      controlId: null,
      trigger: decision.trigger,
      reason: "close_position_api_unavailable",
      detail: "fail_closed_block_without_flatten",
    };
  }

  const entryKey = ownership.entryIntentIds.join(",");
  const controlId = unprotectedFlattenIntentId(input.accountId, input.contractId, entryKey);
  const existing = input.store.mutationForIntent(controlId);
  if (existing) {
    return {
      changed: false,
      flattened: existing.state === "submitted" || existing.state === "submitting",
      blockedNewExposure: true,
      controlId,
      trigger: decision.trigger,
      reason: "idempotent_existing_flatten_mutation",
      detail: `state=${existing.state}`,
    };
  }

  const intent = buildUnprotectedFlattenIntent(
    controlId,
    ownership.entryIntentIds,
    input.accountName,
    input.instrument,
    decision.trigger ?? "rearm_exhausted",
    nowUtc,
  );
  input.store.registerIntent(intent, nowUtc);
  input.store.prepareMutation(
    controlId,
    "close_position",
    { accountId: input.accountId, contractId: input.contractId },
    null,
    nowUtc,
  );
  input.store.markMutationSubmitting(controlId, nowUtc);
  try {
    await input.api.closePosition!(input.accountId, input.contractId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.store.markMutationAmbiguous(controlId, detail, nowUtc);
    input.store.recordReceipt({
      schema_version: "glitch.direct.execution_receipt.v1",
      receipt_id: `unprotected-flatten-${controlId}`,
      recorded_utc: nowUtc,
      intent_id: controlId,
      mode: "armed",
      status: "ambiguous",
      code: "unprotected_fail_closed_flatten_ambiguous",
      detail: `trigger=${decision.trigger};${ownership.detail};error=${detail}`,
    });
    return {
      changed: true,
      flattened: false,
      blockedNewExposure: true,
      controlId,
      trigger: decision.trigger,
      reason: "close_position_outcome_ambiguous",
      detail,
    };
  }
  input.store.markMutationSubmitted(controlId, null, nowUtc);
  input.store.recordReceipt({
    schema_version: "glitch.direct.execution_receipt.v1",
    receipt_id: `unprotected-flatten-${controlId}`,
    recorded_utc: nowUtc,
    intent_id: controlId,
    mode: "armed",
    status: "closed",
    code: "unprotected_fail_closed_flatten_submitted",
    detail: `trigger=${decision.trigger};${ownership.detail}`,
  });

  return {
    changed: true,
    flattened: true,
    blockedNewExposure: true,
    controlId,
    trigger: decision.trigger,
    reason: decision.reason,
    detail: ownership.detail,
  };
}

/** Coordinator-facing orchestration kept out of coordinator.ts for size ratchet. */
export async function runUnprotectedFlattenCycle(input: {
  snapshot: AccountVenueSnapshot;
  store: SqliteExecutionStore;
  api: ExecutionRecoveryApi;
  ledger: JsonlEventStore;
  accountId: number;
  contractId: string;
  accountName: string;
  instrument: string;
  attributableTranches: readonly TrancheView[];
  activeReduction: ProtectedReductionRecord | null;
  afterRearmAttempt: boolean;
  invalidateIssuedPackets: () => void;
  now?: Date;
}): Promise<UnprotectedFlattenResult> {
  const now = input.now ?? new Date();
  const health = evaluateProtectionHealth({
    snapshot: input.snapshot,
    tranches: input.attributableTranches,
    activeReduction: input.activeReduction,
    accountId: input.accountId,
    contractId: input.contractId,
  });
  input.store.updateUnprotectedSince(health.unprotected_open_quantity, now.toISOString());

  const protectionVerificationFailed = anyProtectionVerificationFailed({
    tranches: input.attributableTranches,
    openOrders: input.snapshot.openOrders,
    accountId: input.accountId,
    contractId: input.contractId,
    positionOpen: input.snapshot.instrumentOpenContracts > 0,
    nowUtc: now.toISOString(),
    receiptForIntent: (intentId) => input.store.receiptForIntent(intentId),
  });

  const outcome = await attemptUnprotectedExposureFlatten({
    store: input.store,
    api: input.api,
    accountId: input.accountId,
    contractId: input.contractId,
    accountName: input.accountName,
    instrument: input.instrument,
    positions: input.snapshot.positions,
    attributableTranches: input.attributableTranches,
    unprotectedOpenQuantity: health.unprotected_open_quantity,
    afterRearmAttempt: input.afterRearmAttempt,
    protectionVerificationFailed,
    now,
  });

  if (outcome.changed || outcome.flattened) {
    input.invalidateIssuedPackets();
    await input.ledger.append({
      schema_version: "glitch.direct.event.v1",
      event_id: randomUUID(),
      recorded_utc: now.toISOString(),
      event: outcome.flattened
        ? "unprotected_fail_closed_flatten_submitted"
        : "unprotected_fail_closed_block",
      payload: {
        control_id: outcome.controlId,
        trigger: outcome.trigger,
        reason: outcome.reason,
        detail: outcome.detail,
        blocked_new_exposure: outcome.blockedNewExposure,
        unprotected_open_quantity: health.unprotected_open_quantity,
      },
    });
  }
  return outcome;
}

function unprotectedTimedOut(unprotectedSinceUtc: string | null, nowUtc: string): boolean {
  if (!unprotectedSinceUtc) {
    return false;
  }
  const elapsed = Date.parse(nowUtc) - Date.parse(unprotectedSinceUtc);
  return Number.isFinite(elapsed) && elapsed >= BRACKET_VERIFICATION_TIMEOUT_MS;
}

function buildUnprotectedFlattenIntent(
  controlId: string,
  entryIntentIds: string[],
  accountName: string,
  instrument: string,
  trigger: UnprotectedFlattenTrigger,
  createdUtc: string,
): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: controlId,
    createdUtc,
    instrument,
    account: accountName,
    operatorProfile: GLITCH_TOPSTEP_OPERATOR_PROFILE,
    action: "EXIT",
    confidence: 1,
    snapshotHash: `unprotected-flatten:${entryIntentIds.join(",")}`,
    modelVersion: "gateway-unprotected-flatten",
    promptVersion: GLITCH_TOPSTEP_PROMPT_VERSION,
    reason: `unprotected_fail_closed_flatten:${trigger}`,
    decisionAudit: {
      bullCase: "Owned unprotected exposure must be flattened without Hermes.",
      bearCase: "Never flatten when ownership, contract, or quantity is ambiguous.",
      flatCase: "Contract already flat; no flatten required.",
      aggressiveCase: "Not applicable.",
      conservativeCase: "Close configured owned contract only.",
      decisiveEvidence: `entry_intent_ids=${entryIntentIds.join(",")};trigger=${trigger}`,
      disconfirmingEvidence: "Ambiguous identity blocks flatten and new exposure.",
      changeCondition: "Venue position proves flat and unprotected_open_quantity=0.",
      finalChoice: "EXIT",
    },
  };
}
