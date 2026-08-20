/**
 * Immediate lifecycle facts (TS-EXEC-01).
 *
 * Facts are published on the hot path so the next decision sees factual closure without
 * waiting for the enriched trade outcome. Identity is stable per (intent, moment): a later
 * correction of the same moment lands as a new revision of the same `fact_id`, never as a
 * new identity. Facts stay visible until the revisioned outcome for the same intent
 * supersedes them.
 */

export const LIFECYCLE_DIAGNOSTICS_SCHEMA = "glitch.topstep.lifecycle_diagnostics.v1";

export type LifecycleFactPhase =
  | "intent_admitted"
  | "intent_rejected"
  | "provider_submission_acknowledged"
  | "provider_rejected"
  | "provider_outcome_ambiguous"
  | "exit_submitted"
  | "entry_fill_observed"
  | "partial_fill_observed"
  | "exit_fill_observed"
  | "position_flat"
  | "protection_confirmed"
  | "protection_failed"
  | "amendment_applied"
  | "outcome_superseded"
  | "execution_receipt";

/** How well the venue-side protection of this intent is proven at the time of the fact. */
export type ProtectionFidelity = "proven" | "pending" | "failed" | "not_applicable";

/** Whether the fact was directly observed, derived from reconciled state, or still ambiguous. */
export type FactSourceQuality = "observed" | "derived" | "unresolved";

export interface LifecycleFillDiagnostic {
  observed: boolean;
  filled_quantity: number | null;
  remaining_quantity: number | null;
  partial: boolean | null;
}

/**
 * Latency fields are declared even when unmeasured so consumers can tell "not measured"
 * (null) from "measured as zero" instead of inferring absence from a missing key.
 */
export interface LifecycleLatencyDiagnostic {
  decision_to_admission_ms: number | null;
  admission_to_submission_ms: number | null;
  submission_to_fill_ms: number | null;
  fill_to_protection_ms: number | null;
}

export interface LifecycleDiagnostics {
  schema_version: typeof LIFECYCLE_DIAGNOSTICS_SCHEMA;
  rejection_code: string | null;
  fill: LifecycleFillDiagnostic;
  protection: { fidelity: ProtectionFidelity; reason: string | null };
  latency: LifecycleLatencyDiagnostic;
  source_quality: FactSourceQuality;
}

/** Structural view of an execution receipt; avoids importing the coordinator. */
export interface LifecycleReceiptView {
  status: string;
  code: string;
  detail?: string | null;
  order_id?: number;
  fill_observed_utc?: string;
}

export interface LifecycleLatencyInput {
  decisionUtc?: string | null;
  admittedUtc?: string | null;
  submittedUtc?: string | null;
  fillObservedUtc?: string | null;
  protectionConfirmedUtc?: string | null;
}

export interface LifecycleFact {
  intentId: string;
  /** Stable moment key within the intent; the fact_id is derived from it. */
  factKey: string;
  phase: LifecycleFactPhase;
  recordedUtc: string;
  detail: Record<string, unknown>;
  diagnostics: LifecycleDiagnostics;
}

export interface LifecycleTrancheView {
  intent_id: string;
  filled_qty: number;
  remaining_qty: number;
  protection: { status: string; reason: string };
}

export function lifecycleFactId(intentId: string, factKey: string): string {
  return `fact:${intentId}:${factKey}`;
}

export function lifecycleFactPhase(receipt: LifecycleReceiptView): LifecycleFactPhase {
  if (receipt.status === "rejected") {
    return receipt.code.startsWith("projectx_") ? "provider_rejected" : "intent_rejected";
  }
  if (receipt.status === "ambiguous") {
    return "provider_outcome_ambiguous";
  }
  if (receipt.code === "entry_protection_verification_failed") {
    return "protection_failed";
  }
  if (receipt.status === "open_protected") {
    return "protection_confirmed";
  }
  if (receipt.code === "move_stop_reconciled" || receipt.code === "move_tp_reconciled") {
    return "amendment_applied";
  }
  if (receipt.code.startsWith("close_contract") || receipt.code.startsWith("partial_exit")) {
    return "exit_submitted";
  }
  if (receipt.code.includes("submitted")) {
    return "provider_submission_acknowledged";
  }
  return "execution_receipt";
}

export function lifecycleLatency(input: LifecycleLatencyInput = {}): LifecycleLatencyDiagnostic {
  return {
    decision_to_admission_ms: elapsedMs(input.decisionUtc, input.admittedUtc),
    admission_to_submission_ms: elapsedMs(input.admittedUtc, input.submittedUtc),
    submission_to_fill_ms: elapsedMs(input.submittedUtc, input.fillObservedUtc),
    fill_to_protection_ms: elapsedMs(input.fillObservedUtc, input.protectionConfirmedUtc),
  };
}

export function admissionDiagnostics(decisionUtc: string, admittedUtc: string): LifecycleDiagnostics {
  return {
    schema_version: LIFECYCLE_DIAGNOSTICS_SCHEMA,
    rejection_code: null,
    fill: { observed: false, filled_quantity: null, remaining_quantity: null, partial: null },
    protection: { fidelity: "not_applicable", reason: null },
    latency: lifecycleLatency({ decisionUtc, admittedUtc }),
    source_quality: "observed",
  };
}

export function receiptProtectionFidelity(
  receipt: LifecycleReceiptView,
): { fidelity: ProtectionFidelity; reason: string | null } {
  if (receipt.code === "entry_protection_verification_failed") {
    return { fidelity: "failed", reason: receipt.detail ?? receipt.code };
  }
  if (receipt.status === "open_protected") {
    return { fidelity: "proven", reason: receipt.code };
  }
  if (receipt.code === "entry_submitted_pending_reconciliation") {
    return { fidelity: "pending", reason: receipt.code };
  }
  return { fidelity: "not_applicable", reason: null };
}

export function receiptDiagnostics(
  receipt: LifecycleReceiptView,
  latency: LifecycleLatencyInput = {},
): LifecycleDiagnostics {
  return {
    schema_version: LIFECYCLE_DIAGNOSTICS_SCHEMA,
    rejection_code: receipt.status === "rejected" ? receipt.code : null,
    fill: {
      observed: receipt.fill_observed_utc !== undefined,
      filled_quantity: null,
      remaining_quantity: null,
      partial: null,
    },
    protection: receiptProtectionFidelity(receipt),
    latency: lifecycleLatency(latency),
    source_quality: receipt.status === "ambiguous" ? "unresolved" : "observed",
  };
}

export function receiptLifecycleFact(
  intentId: string,
  receipt: LifecycleReceiptView,
  recordedUtc: string,
  latency: LifecycleLatencyInput = {},
): LifecycleFact {
  const phase = lifecycleFactPhase(receipt);
  return {
    intentId,
    factKey: phase,
    phase,
    recordedUtc,
    detail: {
      status: receipt.status,
      code: receipt.code,
      provider_order_id: receipt.order_id ?? null,
      transport_or_provider_detail: receipt.detail ?? null,
    },
    diagnostics: receiptDiagnostics(receipt, latency),
  };
}

/**
 * Fill state derived from reconciled ownership. One fact identity per intent (`fill`) whose
 * revisions track the progression partial -> filled -> exited, so the feed stays bounded and
 * every refinement keeps the same identity.
 */
export function trancheLifecycleFact(input: {
  tranche: LifecycleTrancheView;
  requestedQuantity: number | null;
  recordedUtc: string;
  instrumentFlat: boolean;
}): LifecycleFact | null {
  const { tranche, requestedQuantity, recordedUtc, instrumentFlat } = input;
  if (tranche.filled_qty <= 0) {
    return null;
  }
  const closed = tranche.remaining_qty <= 0;
  const partial = closed
    ? false
    : requestedQuantity !== null && requestedQuantity > 0
      ? tranche.filled_qty < requestedQuantity
      : tranche.remaining_qty < tranche.filled_qty;
  const phase: LifecycleFactPhase = closed
    ? (instrumentFlat ? "position_flat" : "exit_fill_observed")
    : partial
      ? "partial_fill_observed"
      : "entry_fill_observed";
  return {
    intentId: tranche.intent_id,
    factKey: "fill",
    phase,
    recordedUtc,
    detail: {
      filled_qty: tranche.filled_qty,
      remaining_qty: tranche.remaining_qty,
      requested_qty: requestedQuantity,
      instrument_flat: instrumentFlat,
    },
    diagnostics: {
      schema_version: LIFECYCLE_DIAGNOSTICS_SCHEMA,
      rejection_code: null,
      fill: {
        observed: true,
        filled_quantity: tranche.filled_qty,
        remaining_quantity: tranche.remaining_qty,
        partial,
      },
      protection: trancheProtectionFidelity(tranche.protection),
      latency: lifecycleLatency(),
      // Ownership tranches are rebuilt from reconciled provider state, not from a single
      // observed venue event.
      source_quality: "derived",
    },
  };
}

function trancheProtectionFidelity(
  protection: { status: string; reason: string },
): { fidelity: ProtectionFidelity; reason: string | null } {
  if (protection.status === "proven") {
    return { fidelity: "proven", reason: protection.reason };
  }
  if (protection.status === "incomplete") {
    return { fidelity: "failed", reason: protection.reason };
  }
  return { fidelity: "pending", reason: protection.reason };
}

function elapsedMs(fromUtc: string | null | undefined, toUtc: string | null | undefined): number | null {
  if (!fromUtc || !toUtc) {
    return null;
  }
  const from = Date.parse(fromUtc);
  const to = Date.parse(toUtc);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return Math.max(0, to - from);
}
