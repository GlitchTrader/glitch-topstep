import type { AccountVenueSnapshot, RiskSettings } from "../domain/models.js";
import {
  buildQuoteClassification,
  classifyQuoteState,
  issueCodeForQuoteState,
  type ExecutionEligibility,
  type QuoteClassification,
  type QuoteState,
} from "./quote-state.js";

/** Sanitized quote geometry diagnostics — never includes credentials or raw provider payloads. */
export interface QuoteGeometryTelemetry {
  best_bid: number | null;
  best_ask: number | null;
  last: number | null;
  quote_timestamp: string | null;
  snapshot_captured_at: string | null;
  instrument: string | null;
  contract_id: string | null;
  quote_source: string;
  reconnect_generation: number | null;
  observation_succeeded_utc: string | null;
  reason_codes: string[];
}

export interface SnapshotDataQuality {
  stateComplete: boolean;
  /** Execution-blocking completeness / freshness / quote-state failures. */
  issues: string[];
  quoteAgeMs: number | null;
  stateAgeMs: number | null;
  /** Explicit axes — do not collapse locked into "incomplete data". */
  quoteState: QuoteState;
  /** Advisory completeness only — NEVER treat as execution authorization. */
  dataCompleteness: boolean;
  /** New-exposure / risk-increase gate (source of truth for increasing mutations). */
  executionEligibility: ExecutionEligibility;
  /** Always eligible for quote geometry/stale — exit/flatten/protection/recovery stay open. */
  riskReductionEligibility: "eligible";
  quoteClassification: QuoteClassification;
  /** Present when quote_state is locked or invalid; advisory telemetry. */
  quoteGeometryTelemetry?: QuoteGeometryTelemetry | null;
}

export interface DataQualityObservationContext {
  /** Provenance label for the quote (e.g. projectx_quote_stream). */
  quoteSource?: string;
  /** Market observation last success — packet/observation timing, not a secret. */
  observationSucceededUtc?: string | null;
}

const FUTURE_TOLERANCE_MS = 5_000;
/** Reconciliation cycles can block on ProjectX REST for several seconds. */
const RECONCILIATION_STALE_GRACE_MS = 30_000;
const LAST_INVALID_TELEMETRY_TTL_MS = 120_000;

interface RetainedQuoteGeometryTelemetry {
  telemetry: QuoteGeometryTelemetry;
  /** First time this invalid episode was observed (stable across refreshes). */
  firstObservedAtUtc: string;
  observedAtUtc: string;
  expiresAtUtc: string;
  /** How many invalid observations refreshed this episode within TTL. */
  observationCount: number;
}

let retainedLastInvalidQuoteGeometry: RetainedQuoteGeometryTelemetry | null = null;

export function evaluateSnapshotDataQuality(
  snapshot: AccountVenueSnapshot,
  settings: RiskSettings,
  now: Date = new Date(),
  observation: DataQualityObservationContext = {},
): SnapshotDataQuality {
  const issues = new Set(snapshot.stateIssues);
  if (!snapshot.stateComplete && issues.size === 0) {
    issues.add("venue_state_incomplete");
  }

  let quoteAgeMs = snapshot.quote
    ? ageMilliseconds(snapshot.quote.timestamp, now)
    : null;
  const stateAgeMs = ageMilliseconds(snapshot.capturedAt, now);
  let quoteGeometryTelemetry: QuoteGeometryTelemetry | null = null;
  let quoteState: QuoteState = "invalid";
  let reasonCodes: string[] = ["missing_bbo"];

  if (snapshot.quote) {
    if (quoteAgeMs === null) {
      issues.add("quote_timestamp_invalid");
    } else if (quoteAgeMs < -FUTURE_TOLERANCE_MS) {
      issues.add("quote_timestamp_future");
      quoteAgeMs = 0;
    } else if (quoteAgeMs < 0) {
      // Provider/local clock skew within FUTURE_TOLERANCE is normal NTP jitter.
      // Treat as fresh; do not publish advisory noise or block execution.
      quoteAgeMs = 0;
    } else if (quoteAgeMs > settings.maxQuoteAgeMs) {
      issues.add("quote_stale");
    }
    const classified = classifyQuoteState(snapshot.quote.bestBid, snapshot.quote.bestAsk);
    quoteState = classified.quote_state;
    reasonCodes = classified.reason_codes;
    const geometryIssue = issueCodeForQuoteState(classified.quote_state);
    if (geometryIssue) {
      issues.add(geometryIssue);
      quoteGeometryTelemetry = buildQuoteGeometryTelemetry(snapshot, observation, reasonCodes);
      retainLastInvalidQuoteGeometry(quoteGeometryTelemetry, now);
      logQuoteGeometryEvent(classified.quote_state, quoteGeometryTelemetry);
    }
  } else {
    issues.add("quote_missing");
    quoteGeometryTelemetry = buildQuoteGeometryTelemetry(snapshot, observation, reasonCodes);
    retainLastInvalidQuoteGeometry(quoteGeometryTelemetry, now);
    logQuoteGeometryEvent("invalid", quoteGeometryTelemetry);
  }

  if (stateAgeMs === null) {
    issues.add("account_state_timestamp_invalid");
  } else if (stateAgeMs < -FUTURE_TOLERANCE_MS) {
    issues.add("account_state_timestamp_future");
  } else if (stateAgeMs > settings.maxStateAgeMs && !reconciliationGrace(snapshot, now)) {
    issues.add("account_state_stale");
  }

  const issueList = [...issues];
  const classification = buildQuoteClassification(snapshot, issueList);
  // state_complete remains the execution gate (unchanged meaning): no blocking issues.
  // Locked/invalid appear as issues AND as quote_state / execution_eligibility axes.
  const stateComplete = issueList.length === 0;

  return {
    stateComplete,
    issues: issueList,
    quoteAgeMs,
    stateAgeMs,
    quoteState: classification.quote_state,
    dataCompleteness: classification.data_completeness,
    executionEligibility: classification.execution_eligibility,
    riskReductionEligibility: classification.risk_reduction_eligibility,
    quoteClassification: classification,
    quoteGeometryTelemetry,
  };
}

/** @deprecated Prefer classifyQuoteState — kept for telemetry compatibility. */
export function quoteGeometryReasonCodes(bestBid: number, bestAsk: number): string[] {
  const classified = classifyQuoteState(bestBid, bestAsk);
  return classified.quote_state === "normal" ? [] : classified.reason_codes;
}

export function buildQuoteGeometryTelemetry(
  snapshot: AccountVenueSnapshot,
  observation: DataQualityObservationContext,
  reasonCodes: string[],
): QuoteGeometryTelemetry {
  const quote = snapshot.quote;
  return {
    best_bid: quote && Number.isFinite(quote.bestBid) ? quote.bestBid : null,
    best_ask: quote && Number.isFinite(quote.bestAsk) ? quote.bestAsk : null,
    last: quote && Number.isFinite(quote.lastPrice) ? quote.lastPrice : null,
    quote_timestamp: quote?.timestamp ?? null,
    snapshot_captured_at: snapshot.capturedAt ?? null,
    instrument: snapshot.contract?.symbolId ?? quote?.symbol ?? null,
    contract_id: snapshot.contract?.id ?? quote?.contractId ?? null,
    quote_source: observation.quoteSource ?? "venue_snapshot_quote",
    reconnect_generation: snapshot.operational?.generation ?? null,
    observation_succeeded_utc: observation.observationSucceededUtc ?? null,
    reason_codes: [...reasonCodes],
  };
}

/** Sanitized one-line JSON to stderr — never logs tokens, .env, or raw hub payloads. */
export function logQuoteGeometryInvalid(telemetry: QuoteGeometryTelemetry): void {
  logQuoteGeometryEvent("invalid", telemetry);
}

export function logQuoteGeometryEvent(
  quoteState: QuoteState,
  telemetry: QuoteGeometryTelemetry,
): void {
  const event = quoteState === "locked" ? "quote_locked" : "quote_geometry_invalid";
  console.warn(
    `${event} ${JSON.stringify({
      event,
      quote_state: quoteState,
      ...telemetry,
    })}`,
  );
}

/**
 * Rejection code when quote axes forbid **new exposure / risk-increasing** mutations.
 * Exit, flatten, protection, and recovery must NOT use this — they stay open on locked/invalid/stale.
 */
export function newExposureBlockCode(quality: SnapshotDataQuality): string | null {
  if (quality.executionEligibility === "eligible") {
    return null;
  }
  if (quality.executionEligibility === "blocked_locked" || quality.issues.includes("quote_locked")) {
    return "quote_locked";
  }
  if (quality.executionEligibility === "blocked_invalid" || quality.issues.includes("quote_geometry_invalid")) {
    return "quote_geometry_invalid";
  }
  if (quality.issues.includes("quote_missing")) {
    return "quote_missing";
  }
  return "venue_state_incomplete";
}

/** @deprecated Prefer newExposureBlockCode — name clarified after risk-reduction matrix fix. */
export function mutationBlockCode(quality: SnapshotDataQuality): string | null {
  return newExposureBlockCode(quality);
}

/** Spread onto health `data_quality` — axes are additive; state_complete still gates new exposure. */
export function dataQualityHealthFields(
  quality: SnapshotDataQuality,
  now: Date = new Date(),
): Record<string, unknown> {
  const retained = currentRetainedLastInvalidQuoteGeometry(now);
  return {
    state_complete: quality.stateComplete,
    issues: quality.issues,
    quote_age_ms: quality.quoteAgeMs,
    state_age_ms: quality.stateAgeMs,
    quote_state: quality.quoteState,
    data_completeness: quality.dataCompleteness,
    execution_eligibility: quality.executionEligibility,
    risk_reduction_eligibility: quality.riskReductionEligibility,
    ...(quality.quoteGeometryTelemetry
      ? { quote_geometry: quality.quoteGeometryTelemetry }
      : {}),
    ...(retained
      ? { quote_geometry_last_invalid: retained }
      : {}),
  };
}

export function resetQuoteGeometryTelemetryRetentionForTest(): void {
  retainedLastInvalidQuoteGeometry = null;
}

function retainLastInvalidQuoteGeometry(telemetry: QuoteGeometryTelemetry, now: Date): void {
  const nowIso = now.toISOString();
  const current = currentRetainedLastInvalidQuoteGeometry(now);
  const sameEpisode =
    current !== null
    && current.telemetry.best_bid === telemetry.best_bid
    && current.telemetry.best_ask === telemetry.best_ask
    && current.telemetry.contract_id === telemetry.contract_id
    && sameReasonCodes(current.telemetry.reason_codes, telemetry.reason_codes);

  retainedLastInvalidQuoteGeometry = {
    telemetry: { ...telemetry, reason_codes: [...telemetry.reason_codes] },
    firstObservedAtUtc: sameEpisode ? current.firstObservedAtUtc : nowIso,
    observedAtUtc: nowIso,
    expiresAtUtc: new Date(now.getTime() + LAST_INVALID_TELEMETRY_TTL_MS).toISOString(),
    observationCount: sameEpisode ? current.observationCount + 1 : 1,
  };
}

function sameReasonCodes(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function currentRetainedLastInvalidQuoteGeometry(
  now: Date,
): RetainedQuoteGeometryTelemetry | null {
  if (!retainedLastInvalidQuoteGeometry) {
    return null;
  }
  if (Date.parse(retainedLastInvalidQuoteGeometry.expiresAtUtc) <= now.getTime()) {
    retainedLastInvalidQuoteGeometry = null;
    return null;
  }
  return {
    telemetry: {
      ...retainedLastInvalidQuoteGeometry.telemetry,
      reason_codes: [...retainedLastInvalidQuoteGeometry.telemetry.reason_codes],
    },
    firstObservedAtUtc: retainedLastInvalidQuoteGeometry.firstObservedAtUtc,
    observedAtUtc: retainedLastInvalidQuoteGeometry.observedAtUtc,
    expiresAtUtc: retainedLastInvalidQuoteGeometry.expiresAtUtc,
    observationCount: retainedLastInvalidQuoteGeometry.observationCount,
  };
}

function ageMilliseconds(timestamp: string, now: Date): number | null {
  const epochMs = Date.parse(timestamp);
  return Number.isFinite(epochMs) ? now.getTime() - epochMs : null;
}

function reconciliationGrace(snapshot: AccountVenueSnapshot, now: Date): boolean {
  const reconciliation = snapshot.operational?.reconciliation;
  if (
    !reconciliation
    || reconciliation.generation !== snapshot.operational.generation
  ) {
    return false;
  }
  const timestamp = reconciliation.state === "running"
    ? reconciliation.lastStartedAt
    : reconciliation.state === "succeeded"
      ? reconciliation.lastSucceededAt
      : null;
  if (!timestamp) {
    return false;
  }
  const ageMs = ageMilliseconds(timestamp, now);
  return ageMs !== null && ageMs >= 0 && ageMs <= RECONCILIATION_STALE_GRACE_MS;
}
