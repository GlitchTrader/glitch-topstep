import type { AccountVenueSnapshot, RiskSettings } from "../domain/models.js";

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
  /** Execution-blocking completeness / freshness failures. */
  issues: string[];
  quoteAgeMs: number | null;
  stateAgeMs: number | null;
  /** Present only when `quote_geometry_invalid` is raised; advisory telemetry. */
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
    const geometryReasons = quoteGeometryReasonCodes(snapshot.quote.bestBid, snapshot.quote.bestAsk);
    if (geometryReasons.length > 0) {
      issues.add("quote_geometry_invalid");
      quoteGeometryTelemetry = buildQuoteGeometryTelemetry(snapshot, observation, geometryReasons);
      retainLastInvalidQuoteGeometry(quoteGeometryTelemetry, now);
      logQuoteGeometryInvalid(quoteGeometryTelemetry);
    }
  }

  if (stateAgeMs === null) {
    issues.add("account_state_timestamp_invalid");
  } else if (stateAgeMs < -FUTURE_TOLERANCE_MS) {
    issues.add("account_state_timestamp_future");
  } else if (stateAgeMs > settings.maxStateAgeMs && !reconciliationGrace(snapshot, now)) {
    issues.add("account_state_stale");
  }

  return {
    // Safety decision unchanged: any issue keeps state incomplete.
    stateComplete: issues.size === 0,
    issues: [...issues],
    quoteAgeMs,
    stateAgeMs,
    quoteGeometryTelemetry,
  };
}

export function quoteGeometryReasonCodes(bestBid: number, bestAsk: number): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    reasons.push("nonfinite_bbo");
  }
  if (!(bestBid > 0) || !(bestAsk > 0)) {
    reasons.push("nonpositive_bbo");
  }
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid === bestAsk) {
    reasons.push("locked_bbo");
  }
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > bestAsk) {
    reasons.push("crossed_bbo");
  }
  // Mirror gate: bestBid >= bestAsk (locked or crossed) already covered; keep explicit for telemetry.
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid >= bestAsk && bestBid !== bestAsk) {
    // crossed already added
  }
  return reasons;
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
  console.warn(
    `quote_geometry_invalid ${JSON.stringify({
      event: "quote_geometry_invalid",
      ...telemetry,
    })}`,
  );
}

/** Spread onto health `data_quality` without changing completeness semantics. */
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
