import type { ProtectionStatus } from "../ownership/protection.js";

/** Hermes-facing terminal protection state (GTHP-020). */
export type PacketProtectionStatus = "pending" | "confirmed" | "failed" | "unknown";

/** Wall-clock window after fill observation before `protection_status` becomes `failed`. */
export const BRACKET_VERIFICATION_TIMEOUT_MS = 30_000;

export interface BracketVerificationInput {
  positionOpen: boolean;
  internalStatus: ProtectionStatus;
  fillObservedUtc: string | null;
  stateComplete: boolean;
  nowUtc: string;
  timeoutMs?: number;
}

export interface BracketVerificationResult {
  protection_status: PacketProtectionStatus;
  reason: string;
  elapsed_ms: number | null;
  timed_out: boolean;
}

export function resolvePacketProtectionStatus(
  input: BracketVerificationInput,
): BracketVerificationResult {
  const timeoutMs = input.timeoutMs ?? BRACKET_VERIFICATION_TIMEOUT_MS;
  if (!input.positionOpen) {
    return {
      protection_status: "unknown",
      reason: "no_open_position",
      elapsed_ms: null,
      timed_out: false,
    };
  }
  if (!input.stateComplete) {
    return {
      protection_status: "unknown",
      reason: "reconciliation_incomplete",
      elapsed_ms: null,
      timed_out: false,
    };
  }
  if (input.internalStatus === "proven") {
    return {
      protection_status: "confirmed",
      reason: "sl_tp_verified_on_venue",
      elapsed_ms: elapsedMs(input.fillObservedUtc, input.nowUtc),
      timed_out: false,
    };
  }
  if (input.internalStatus === "incomplete") {
    return {
      protection_status: "failed",
      reason: "venue_protection_mismatch",
      elapsed_ms: elapsedMs(input.fillObservedUtc, input.nowUtc),
      timed_out: false,
    };
  }
  const elapsed = elapsedMs(input.fillObservedUtc, input.nowUtc);
  if (input.internalStatus === "pending" && elapsed !== null && elapsed >= timeoutMs) {
    return {
      protection_status: "failed",
      reason: "bracket_verification_timeout",
      elapsed_ms: elapsed,
      timed_out: true,
    };
  }
  if (input.internalStatus === "pending") {
    return {
      protection_status: "pending",
      reason: input.fillObservedUtc === null
        ? "fill_not_yet_observed"
        : "awaiting_sl_tp_on_venue",
      elapsed_ms: elapsed,
      timed_out: false,
    };
  }
  return {
    protection_status: "unknown",
    reason: "protection_state_unresolved",
    elapsed_ms: elapsed,
    timed_out: false,
  };
}

export interface BracketVerificationEvent {
  event: "bracket_verification_confirmed" | "bracket_verification_failed";
  intent_id: string;
  protection_status: PacketProtectionStatus;
  reason: string;
  elapsed_ms: number | null;
}

function elapsedMs(fillObservedUtc: string | null, nowUtc: string): number | null {
  if (!fillObservedUtc) {
    return null;
  }
  const start = Date.parse(fillObservedUtc);
  const end = Date.parse(nowUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}
