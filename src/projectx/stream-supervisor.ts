/** ponytail: SignalR default policy stops after 4 tries (~42s); stay down until process restart. */
export const SIGNALR_RECONNECT_DELAYS_MS = [0, 2_000, 10_000, 30_000, 60_000] as const;
export const DEFAULT_STREAM_LIVENESS_MS = 15_000;

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
