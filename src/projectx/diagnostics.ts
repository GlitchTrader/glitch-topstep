export interface ProjectXDiagnosticContext {
  reconciliation_state: string | null;
  reconciliation_generation: number | null;
  state_complete: boolean | null;
  user_stream_fresh: boolean | null;
  quote_stale: boolean | null;
}

export interface ProjectXRestDiagnostic {
  schema_version: "glitch.projectx.rest_diagnostic.v1";
  endpoint: string;
  started_utc: string;
  finished_utc: string;
  latency_ms: number;
  status_http: number | null;
  error_class: string | null;
  error_message: string | null;
  timed_out: boolean;
  cancelled: boolean;
  attempt: number;
  retry_performed: boolean;
  retry_after_ms: number | null;
  session_correlation: string;
  reconciliation_state: string | null;
  reconciliation_generation: number | null;
  state_complete: boolean | null;
  user_stream_fresh: boolean | null;
  quote_stale: boolean | null;
}

export interface ProjectXStreamDiagnostic {
  schema_version: "glitch.projectx.stream_diagnostic.v1";
  hub: "user" | "market";
  previous_state: string;
  new_state: string;
  event: string;
  occurred_utc: string;
  close_code: string | number | null;
  error_message: string | null;
  generation: number;
  reconnect_count: number;
  last_event_utc: string | null;
  last_event_age_ms: number | null;
}

export interface ProjectXDiagnosticsSink {
  rest(event: ProjectXRestDiagnostic): void;
  stream(event: ProjectXStreamDiagnostic): void;
}

export type ProjectXDiagnosticLogLevel = "info" | "warn" | "error";

export interface ProjectXDiagnosticLogger {
  info(message: string, event: ProjectXRestDiagnostic): void;
  warn(message: string, event: ProjectXRestDiagnostic): void;
  error(message: string, event: ProjectXRestDiagnostic): void;
}

export function projectXRestDiagnosticLogLevel(event: ProjectXRestDiagnostic): ProjectXDiagnosticLogLevel {
  if (!event.error_class) return "info";
  return event.error_class === "rate_limited" || event.error_class === "server_error"
    ? "warn"
    : "error";
}

export function logProjectXRestDiagnostic(
  event: ProjectXRestDiagnostic,
  logger: ProjectXDiagnosticLogger = console,
): void {
  const level = projectXRestDiagnosticLogLevel(event);
  logger[level]("ProjectX REST diagnostic", event);
}

const STREAM_STDERR_EVENTS = new Set([
  "reconnecting",
  "closed",
  "liveness_restart",
  "stuck_stream_restart",
  "restart_failed",
  "connect_failed",
]);

export const projectXConsoleDiagnostics: ProjectXDiagnosticsSink = {
  rest: (event) => logProjectXRestDiagnostic(event),
  stream: (event) => {
    if (STREAM_STDERR_EVENTS.has(event.event) || event.error_message || event.new_state === "disconnected") {
      console.error("ProjectX stream diagnostic", event);
    } else if (event.new_state === "connected" && !event.error_message) {
      console.info("ProjectX stream diagnostic", event);
    } else {
      console.warn("ProjectX stream diagnostic", event);
    }
  },
};

export function projectXDiagnosticContext(
  state: VenueStateStore,
  config: AppConfig,
): ProjectXDiagnosticContext {
  const operational = state.operationalStatus();
  let stateComplete: boolean | null = null;
  let quoteStale: boolean | null = null;
  try {
    const snapshot = state.buildSnapshot(config.scope.accountId, config.scope.contractId);
    if (snapshot.quote) {
      const quoteAgeMs = Date.now() - Date.parse(snapshot.quote.timestamp);
      quoteStale = !Number.isFinite(quoteAgeMs) || quoteAgeMs > config.risk.maxQuoteAgeMs;
    } else {
      quoteStale = true;
    }
    stateComplete = snapshot.stateComplete
      && quoteStale !== true
      && operational.userStream.state === "connected"
      && operational.marketStream.state === "connected"
      && operational.reconciliation.state === "succeeded"
      && operational.reconciliation.generation === operational.generation;
  } catch {
    // Startup diagnostics may run before account/contract snapshots exist.
  }
  const userEventAgeMs = operational.userStream.lastEventAt
    ? Date.now() - Date.parse(operational.userStream.lastEventAt)
    : null;
  return {
    reconciliation_state: operational.reconciliation.state,
    reconciliation_generation: operational.reconciliation.generation,
    state_complete: stateComplete,
    user_stream_fresh: operational.userStream.state === "connected"
      && userEventAgeMs !== null
      && Number.isFinite(userEventAgeMs)
      && userEventAgeMs <= config.risk.maxStateAgeMs,
    quote_stale: quoteStale,
  };
}
import type { AppConfig } from "../config.js";
import type { VenueStateStore } from "../state/venue-state.js";
