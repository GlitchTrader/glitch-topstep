/** Issue ids from venue-state `stateIssues` / data_quality — streams not stably connected. */
export const WATCHDOG_STREAM_STUCK_ISSUES = [
  "market_stream_disconnected",
  "user_stream_disconnected",
  "market_stream_connecting",
  "user_stream_connecting",
  "market_stream_reconnecting",
  "user_stream_reconnecting",
] as const;

export interface WatchdogHealthSnapshot {
  status: string;
  data_quality?: {
    issues?: string[];
  };
}

/**
 * Process-level restart when in-process hub restart cannot recover (network blip / SignalR limbo).
 * Keep in sync with `scripts/gateway-health-watchdog.ps1` Test-WatchdogRecoveryNeeded.
 */
export function shouldWatchdogRestartGateway(health: WatchdogHealthSnapshot | null): boolean {
  if (health === null) {
    return true;
  }
  if (health.status !== "degraded") {
    return false;
  }
  const issues = health.data_quality?.issues ?? [];
  const streamStuck = WATCHDOG_STREAM_STUCK_ISSUES.some((id) => issues.includes(id));
  const quoteStale = issues.includes("quote_stale");
  const reconciliationStale = issues.includes("reconciliation_not_current");
  return quoteStale && (streamStuck || reconciliationStale);
}
