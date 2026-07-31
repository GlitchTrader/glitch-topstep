import type { AccountVenueSnapshot } from "../domain/models.js";
import { isReconciliationCurrent } from "../state/venue-state.js";

export const RECONNECT_PROOF_SCHEMA = "glitch.projectx.reconnect_proof.v1" as const;

export interface ReconnectProofPhase {
  label: string;
  recorded_utc: string;
  operational_generation: number;
  reconciliation_generation: number;
  reconciliation_state: string;
  user_stream_state: string;
  market_stream_state: string;
  state_complete: boolean;
  reconciliation_current: boolean;
  issued_packet_snapshot_hash: string | null;
  issued_packet_resolvable: boolean;
}

export interface ReconnectEvidenceEvent {
  sequence: number;
  event_type: string;
  source: string;
  generation: number;
  received_utc: string;
}

export interface ReconnectProof {
  schema_version: typeof RECONNECT_PROOF_SCHEMA;
  captured_utc: string;
  mode: "deterministic_fixture" | "live_acceptance_gap";
  scope: {
    account_id: number;
    account_name: string;
    contract_id: string;
    instrument: string;
  };
  phases: ReconnectProofPhase[];
  evidence_timeline: ReconnectEvidenceEvent[];
  proof_passed: boolean;
  proof_failures: string[];
}

export function snapshotReconnectPhase(
  label: string,
  snapshot: AccountVenueSnapshot,
  issuedPacketSnapshotHash: string | null,
  issuedPacketResolvable: boolean,
  recordedUtc = new Date().toISOString(),
): ReconnectProofPhase {
  const operational = snapshot.operational;
  return {
    label,
    recorded_utc: recordedUtc,
    operational_generation: operational.generation,
    reconciliation_generation: operational.reconciliation.generation,
    reconciliation_state: operational.reconciliation.state,
    user_stream_state: operational.userStream.state,
    market_stream_state: operational.marketStream.state,
    state_complete: snapshot.stateComplete,
    reconciliation_current: isReconciliationCurrent(operational),
    issued_packet_snapshot_hash: issuedPacketSnapshotHash,
    issued_packet_resolvable: issuedPacketResolvable,
  };
}

export function buildReconnectProof(input: {
  capturedUtc: string;
  mode: ReconnectProof["mode"];
  scope: ReconnectProof["scope"];
  phases: ReconnectProofPhase[];
  evidenceTimeline?: ReconnectEvidenceEvent[];
}): ReconnectProof {
  const evidenceTimeline = input.evidenceTimeline ?? [];
  const failures = validateReconnectProofPhases(input.phases, evidenceTimeline);
  return {
    schema_version: RECONNECT_PROOF_SCHEMA,
    captured_utc: input.capturedUtc,
    mode: input.mode,
    scope: input.scope,
    phases: input.phases,
    evidence_timeline: evidenceTimeline,
    proof_passed: failures.length === 0,
    proof_failures: failures,
  };
}

export function validateReconnectProof(proof: ReconnectProof): string[] {
  if (proof.schema_version !== RECONNECT_PROOF_SCHEMA) {
    return ["schema_version_invalid"];
  }
  if (!proof.proof_passed) {
    return [...proof.proof_failures];
  }
  return validateReconnectProofPhases(proof.phases, proof.evidence_timeline);
}

function validateReconnectProofPhases(
  phases: ReconnectProofPhase[],
  evidenceTimeline: ReconnectEvidenceEvent[],
): string[] {
  const failures: string[] = [];
  if (phases.length < 3) {
    failures.push("phases_incomplete");
    return failures;
  }

  const baseline = phases[0]!;
  const gap = phases.find((phase) => phase.label === "after_stream_gap");
  const settled = phases[phases.length - 1]!;

  if (!gap) {
    failures.push("after_stream_gap_phase_missing");
  } else {
    if (gap.operational_generation <= baseline.operational_generation) {
      failures.push("generation_not_incremented");
    }
    if (gap.reconciliation_current) {
      failures.push("reconciliation_still_current_during_gap");
    }
    if (gap.state_complete) {
      failures.push("state_complete_during_gap");
    }
    if (gap.issued_packet_resolvable) {
      failures.push("issued_packet_still_resolvable_during_gap");
    }
  }

  if (!settled.reconciliation_current) {
    failures.push("reconciliation_not_current_after_settle");
  }
  if (!settled.state_complete) {
    failures.push("state_not_complete_after_settle");
  }
  if (!settled.issued_packet_resolvable) {
    failures.push("issued_packet_not_resolvable_after_settle");
  }
  if (settled.operational_generation !== settled.reconciliation_generation) {
    failures.push("final_generation_mismatch");
  }

  const reconnecting = evidenceTimeline.some((event) => event.event_type.endsWith("_reconnecting"));
  const reconnected = evidenceTimeline.some((event) => event.event_type.endsWith("_reconnected_and_subscribed"));
  if (reconnecting && !reconnected) {
    failures.push("natural_reconnect_timeline_incomplete");
  }

  return failures;
}

export function extractReconnectEvidenceTimeline(
  rows: Array<{
    sequence: number | bigint;
    event_type: string;
    source: string;
    generation: number | bigint;
    received_utc: string;
  }>,
): ReconnectEvidenceEvent[] {
  const interesting = new Set([
    "user_reconnecting",
    "market_reconnecting",
    "user_reconnected_and_subscribed",
    "market_reconnected_and_subscribed",
    "user_closed",
    "market_closed",
    "accounts_snapshot",
    "positions_snapshot",
    "open_orders_snapshot",
  ]);
  return rows
    .filter((row) => interesting.has(String(row.event_type)))
    .map((row) => ({
      sequence: Number(row.sequence),
      event_type: String(row.event_type),
      source: String(row.source),
      generation: Number(row.generation),
      received_utc: String(row.received_utc),
    }));
}
