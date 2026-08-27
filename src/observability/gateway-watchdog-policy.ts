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

/**
 * Process-level restart when in-process hub restart cannot recover (network blip / SignalR limbo).
 * Keep in sync with `scripts/gateway-health-watchdog.ps1` Test-WatchdogRecoveryNeeded.
 */
export function shouldWatchdogRestartGateway(health: WatchdogHealthSnapshot | null): boolean {
  if (health === null) {
    return true;
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

export function watchdogRestartCause(health: WatchdogHealthSnapshot | null): string {
  if (health === null) {
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
