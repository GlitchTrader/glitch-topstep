/** Cap delay for SignalR auto-reconnect and for our hub restart loop (never returns null). */
export const SIGNALR_RECONNECT_DELAYS_MS = [0, 2_000, 10_000, 30_000, 60_000] as const;
export const DEFAULT_STREAM_LIVENESS_MS = 15_000;
/** Connected-but-silent quote/user event age before forcing a hub restart. */
export const DEFAULT_HUB_START_TIMEOUT_MS = 45_000;
/**
 * connecting/disconnected without progress past this age → force restartHub.
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

export function shouldForceMarketLivenessRestart(input: {
  stopped: boolean;
  expectedLive: boolean;
  streamState: string;
  lastEventAt: string | null;
  connectedSinceUtc: string | null;
  nowMs: number;
  livenessMs: number;
}): boolean {
  if (input.stopped || !input.expectedLive) {
    return false;
  }
  if (input.streamState !== "connected" && input.streamState !== "degraded") {
    return false;
  }
  const anchor = input.lastEventAt ?? input.connectedSinceUtc;
  if (!anchor) {
    return false;
  }
  const age = input.nowMs - Date.parse(anchor);
  return Number.isFinite(age) && age >= input.livenessMs;
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
  if (input.streamState !== "connecting" && input.streamState !== "disconnected") {
    return false;
  }
  if (!input.lastChangedAt) {
    return false;
  }
  const age = input.nowMs - Date.parse(input.lastChangedAt);
  return Number.isFinite(age) && age >= input.stuckMs;
}
