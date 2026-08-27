/** Cap delay for SignalR auto-reconnect and for our hub restart loop (never returns null). */
export const SIGNALR_RECONNECT_DELAYS_MS = [0, 2_000, 10_000, 30_000, 60_000] as const;
export const DEFAULT_STREAM_LIVENESS_MS = 15_000;
/** Liveness timer cadence; worst-case debounce adds (N-1) × this before restartHub. */
export const DEFAULT_LIVENESS_CHECK_INTERVAL_MS = 5_000;
/** Consecutive stale hub checks required before market liveness restart (see hubLivenessWorstCaseMs). */
export const DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES = 3;
/** Connected-but-silent quote/user event age before forcing a hub restart. */
export const DEFAULT_HUB_START_TIMEOUT_MS = 45_000;
/**
 * connecting/disconnected/reconnecting without progress past this age → force restartHub.
 * Must exceed the longest reconnect sleep (60s) plus one start attempt.
 */
export const DEFAULT_STUCK_STREAM_MS = 90_000;

export function nextSignalRReconnectDelayMs(previousRetryCount: number): number {
  const last = SIGNALR_RECONNECT_DELAYS_MS.length - 1;
  const index = Math.min(Math.max(0, previousRetryCount), last);
  return SIGNALR_RECONNECT_DELAYS_MS[index]!;
}

export function shouldScheduleHubRestart(input: {
  stopped: boolean;
  restartInFlight: boolean;
}): boolean {
  return !input.stopped && !input.restartInFlight;
}

export function livenessCheckIntervalMs(livenessMs: number): number {
  return Math.min(DEFAULT_LIVENESS_CHECK_INTERVAL_MS, livenessMs);
}

/** Worst-case delay from first stale hub event to liveness restartHub. */
export function hubLivenessWorstCaseMs(
  livenessMs: number,
  debounceFailures = DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
  checkIntervalMs = DEFAULT_LIVENESS_CHECK_INTERVAL_MS,
): number {
  return livenessMs + (debounceFailures - 1) * checkIntervalMs;
}

/** Hub alive: any quote, trade, or depth on the market stream (not quote-only). */
export function isHubMarketEventStale(input: {
  lastHubEventAt: string | null;
  connectedSinceUtc: string | null;
  nowMs: number;
  livenessMs: number;
}): boolean {
  const anchor = input.lastHubEventAt ?? input.connectedSinceUtc;
  if (!anchor) {
    return false;
  }
  const age = input.nowMs - Date.parse(anchor);
  return Number.isFinite(age) && age >= input.livenessMs;
}

export function shouldForceMarketLivenessRestart(input: {
  stopped: boolean;
  expectedLive: boolean;
  streamState: string;
  lastHubEventAt: string | null;
  connectedSinceUtc: string | null;
  nowMs: number;
  livenessMs: number;
  consecutiveStaleChecks: number;
  debounceFailures?: number;
}): boolean {
  if (input.stopped || !input.expectedLive) {
    return false;
  }
  // ponytail: stuck_stream_restart (90s) covers reconnecting limbo; avoid competing with SignalR auto-reconnect.
  if (input.streamState === "reconnecting") {
    return false;
  }
  if (input.streamState !== "connected" && input.streamState !== "degraded") {
    return false;
  }
  if (!isHubMarketEventStale(input)) {
    return false;
  }
  const debounce = input.debounceFailures ?? DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES;
  return input.consecutiveStaleChecks >= debounce;
}

/** Recover when hub start hangs or reconnect loop leaves the stream offline. */
export function shouldForceStuckStreamRestart(input: {
  stopped: boolean;
  streamState: string;
  lastChangedAt: string | null;
  nowMs: number;
  stuckMs: number;
}): boolean {
  if (input.stopped) {
    return false;
  }
  if (
    input.streamState !== "connecting"
    && input.streamState !== "disconnected"
    && input.streamState !== "reconnecting"
  ) {
    return false;
  }
  if (!input.lastChangedAt) {
    return false;
  }
  const age = input.nowMs - Date.parse(input.lastChangedAt);
  return Number.isFinite(age) && age >= input.stuckMs;
}
