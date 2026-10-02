/** Issue ids from venue-state `stateIssues` / data_quality — streams not stably connected. */
export const WATCHDOG_STREAM_STUCK_ISSUES = [
  "market_stream_disconnected",
  "user_stream_disconnected",
  "market_stream_connecting",
  "user_stream_connecting",
  "market_stream_reconnecting",
  "user_stream_reconnecting",
] as const;

export interface HubRecoveryHealthSnapshot {
  active?: boolean;
  kind?: string | null;
  phase?: string | null;
  started_at?: string | null;
  last_progress_at?: string | null;
  attempt?: number;
  deadline_at?: string | null;
  generation?: number;
}

export interface WatchdogHealthSnapshot {
  status: string;
  data_quality?: {
    issues?: string[];
  };
  recovery?: HubRecoveryHealthSnapshot;
}

/** Grace while hub recovery reports fresh progress (keep in sync with watchdog script). */
export const WATCHDOG_RECOVERY_PROGRESS_GRACE_MS = 5 * 60 * 1000;

export function isRecoveryProgressFresh(
  recovery: HubRecoveryHealthSnapshot,
  nowMs: number,
  graceMs = WATCHDOG_RECOVERY_PROGRESS_GRACE_MS,
): boolean {
  if (!recovery.active) {
    return false;
  }
  const progressAt = recovery.last_progress_at;
  if (!progressAt) {
    return false;
  }
  const age = nowMs - Date.parse(progressAt);
  return Number.isFinite(age) && age >= 0 && age < graceMs;
}

export function baseWatchdogRecoveryNeeded(health: WatchdogHealthSnapshot): boolean {
  if (health.status !== "degraded") {
    return false;
  }
  const issues = health.data_quality?.issues ?? [];
  const streamStuck = WATCHDOG_STREAM_STUCK_ISSUES.some((id) => issues.includes(id));
  const quoteStale = issues.includes("quote_stale");
  const reconciliationStale = issues.includes("reconciliation_not_current");
  return quoteStale && (streamStuck || reconciliationStale);
}

/** One `startup_outbox_drain` log line from the gateway process (before /health exists). */
export interface StartupOutboxDrainObservation {
  pending: number;
  drained_so_far: number;
  /** Process that emitted the line. A pid change is a new boot, not a stall. */
  pid?: number;
}

export type StartupOutboxDrainDecision = "hold" | "stalled" | "absent";

/** Stop automatic restart after this many identical startup failures in a row. */
export const WATCHDOG_REPEATED_STARTUP_FAILURE_LIMIT = 3;

export interface StartupFailureTracker {
  cause: string | null;
  count: number;
}

/** A new cause starts at 1. The same cause increments. Keep in sync with the watchdog script. */
export function recordStartupFailure(
  previous: StartupFailureTracker,
  cause: string,
): StartupFailureTracker {
  if (previous.cause === cause) {
    return { cause, count: previous.count + 1 };
  }
  return { cause, count: 1 };
}

export function startupFailureBlocksRestart(
  tracker: StartupFailureTracker,
  limit = WATCHDOG_REPEATED_STARTUP_FAILURE_LIMIT,
): boolean {
  return tracker.cause !== null && tracker.cause.length > 0 && tracker.count >= limit;
}

/**
 * Health is down because the process has not opened the port yet.
 * Hold while the startup outbox backlog is shrinking. Two samples with no progress are a real stall.
 * pending === 0 (drain finished) is absent: post-drain hangs still use the normal unreachable grace.
 */
export function startupOutboxDrainDecision(
  previous: StartupOutboxDrainObservation | null,
  current: StartupOutboxDrainObservation | null,
): StartupOutboxDrainDecision {
  if (current === null || current.pending <= 0) {
    return "absent";
  }
  if (previous === null) {
    return "hold";
  }
  if (
    current.pid !== undefined &&
    previous.pid !== undefined &&
    current.pid !== previous.pid
  ) {
    return "hold";
  }
  const pendingFell = current.pending < previous.pending;
  const drainedRose = current.drained_so_far > previous.drained_so_far;
  return pendingFell || drainedRose ? "hold" : "stalled";
}

/** Parse one stdout line. Keep in sync with the watchdog script. */
export function parseStartupOutboxDrainLine(line: string): StartupOutboxDrainObservation | null {
  const match = line.match(/startup_outbox_drain\s+(\{.*\})/);
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as Partial<StartupOutboxDrainObservation>;
    if (!Number.isFinite(parsed.pending) || !Number.isFinite(parsed.drained_so_far)) {
      return null;
    }
    const pid = Number.isFinite(parsed.pid) ? Number(parsed.pid) : undefined;
    return {
      pending: Number(parsed.pending),
      drained_so_far: Number(parsed.drained_so_far),
      ...(pid === undefined ? {} : { pid }),
    };
  } catch {
    return null;
  }
}

/**
 * Process-level restart when in-process hub restart cannot recover (network blip / SignalR limbo).
 * Keep in sync with `scripts/gateway-health-watchdog.ps1` Test-WatchdogRecoveryNeeded.
 * When health is null, a progressing startup outbox drain is not a dead process.
 */
export function shouldWatchdogRestartGateway(
  health: WatchdogHealthSnapshot | null,
  startupDrain: {
    previous: StartupOutboxDrainObservation | null;
    current: StartupOutboxDrainObservation | null;
  } | null = null,
): boolean {
  if (health === null) {
    const decision = startupOutboxDrainDecision(
      startupDrain?.previous ?? null,
      startupDrain?.current ?? null,
    );
    return decision !== "hold";
  }
  if (!baseWatchdogRecoveryNeeded(health)) {
    return false;
  }
  const recovery = health.recovery;
  if (!recovery?.active) {
    return true;
  }
  const nowMs = Date.now();
  if (isRecoveryProgressFresh(recovery, nowMs)) {
    return false;
  }
  const deadlineAt = recovery.deadline_at;
  if (deadlineAt && nowMs < Date.parse(deadlineAt)) {
    return false;
  }
  return true;
}

export function watchdogRestartCause(
  health: WatchdogHealthSnapshot | null,
  startupDrain: {
    previous: StartupOutboxDrainObservation | null;
    current: StartupOutboxDrainObservation | null;
  } | null = null,
): string {
  if (health === null) {
    const decision = startupOutboxDrainDecision(
      startupDrain?.previous ?? null,
      startupDrain?.current ?? null,
    );
    if (decision === "hold") {
      return "startup_outbox_drain_progressing";
    }
    if (decision === "stalled") {
      return "startup_outbox_drain_stalled";
    }
    return "health_unreachable";
  }
  if (!baseWatchdogRecoveryNeeded(health)) {
    return "not_needed";
  }
  const recovery = health.recovery;
  if (recovery?.active) {
    const nowMs = Date.now();
    if (isRecoveryProgressFresh(recovery, nowMs)) {
      return "recovery_progress_fresh";
    }
    if (recovery.deadline_at && nowMs < Date.parse(recovery.deadline_at)) {
      return "recovery_within_deadline";
    }
    return "recovery_stalled_past_deadline";
  }
  const issues = health.data_quality?.issues ?? [];
  if (issues.includes("quote_stale") && issues.some((id) => (
    WATCHDOG_STREAM_STUCK_ISSUES as readonly string[]
  ).includes(id))) {
    return "quote_stale_with_stream_stuck";
  }
  if (issues.includes("quote_stale") && issues.includes("reconciliation_not_current")) {
    return "quote_stale_with_reconciliation_lag";
  }
  return "degraded_recovery_needed";
}
