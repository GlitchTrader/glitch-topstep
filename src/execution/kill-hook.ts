/**
 * Deterministic process-kill hooks for TS-R1-01 fixtures.
 * Active only when GLITCH_KILL_POINT equals the named lifecycle point.
 * Exit code 73 is the kill-matrix sentinel (not a normal coordinator failure).
 */
export const KILL_EXIT_CODE = 73;

export const KILL_POINTS = [
  "after_intent_before_outbox",
  "after_prepared_before_provider",
  "after_submitting_before_transport",
  "during_transport_stall",
  "after_accept_before_submitted",
  "after_submitted_before_receipt",
  "after_receipt_before_jsonl",
  "during_close_position",
  "during_recovery",
  "during_duplicate_wait",
  "reduction_after_prepared",
  "reduction_after_cancel_before_place",
  "reduction_after_place_before_mark",
  "rearm_after_stop_before_tp",
] as const;

export type KillPoint = (typeof KILL_POINTS)[number];

export function activeKillPoint(): KillPoint | null {
  const value = process.env.GLITCH_KILL_POINT;
  if (!value) {
    return null;
  }
  return (KILL_POINTS as readonly string[]).includes(value) ? value as KillPoint : null;
}

export function maybeKill(point: KillPoint): void {
  if (activeKillPoint() !== point) {
    return;
  }
  console.error(`GLITCH_KILL:${point}:pid=${process.pid}`);
  process.exit(KILL_EXIT_CODE);
}

export function killPointIs(point: KillPoint): boolean {
  return activeKillPoint() === point;
}
