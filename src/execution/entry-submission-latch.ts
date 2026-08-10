import type { StoredExecutionMutation } from "../domain/execution-state.js";

/** ponytail: stale latch auto-clear ceiling; override via GLITCH_ENTRY_SUBMISSION_LATCH_STALE_MS */
export const DEFAULT_ENTRY_SUBMISSION_LATCH_STALE_MS = 300_000;

export function shouldClearStaleEntrySubmissionLatch(
  mutation: StoredExecutionMutation,
  atUtc: string,
  staleMs: number,
  venueFlat: boolean,
  positionObserved: boolean,
  orderObserved: boolean,
): boolean {
  if (positionObserved || orderObserved || !venueFlat) {
    return false;
  }
  if (mutation.operation !== "place_order" || mutation.state !== "submitted") {
    return false;
  }
  const anchorUtc = mutation.resolvedUtc ?? mutation.createdUtc;
  return Date.parse(atUtc) - Date.parse(anchorUtc) >= staleMs;
}
