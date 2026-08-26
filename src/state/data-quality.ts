import type { AccountVenueSnapshot, RiskSettings } from "../domain/models.js";

export interface SnapshotDataQuality {
  stateComplete: boolean;
  /** Execution-blocking completeness / freshness failures. */
  issues: string[];
  quoteAgeMs: number | null;
  stateAgeMs: number | null;
}

const FUTURE_TOLERANCE_MS = 5_000;
/** Reconciliation cycles can block on ProjectX REST for several seconds. */
const RECONCILIATION_STALE_GRACE_MS = 30_000;

export function evaluateSnapshotDataQuality(
  snapshot: AccountVenueSnapshot,
  settings: RiskSettings,
  now: Date = new Date(),
): SnapshotDataQuality {
  const issues = new Set(snapshot.stateIssues);
  if (!snapshot.stateComplete && issues.size === 0) {
    issues.add("venue_state_incomplete");
  }

  let quoteAgeMs = snapshot.quote
    ? ageMilliseconds(snapshot.quote.timestamp, now)
    : null;
  const stateAgeMs = ageMilliseconds(snapshot.capturedAt, now);

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
    if (
      !Number.isFinite(snapshot.quote.bestBid)
      || !Number.isFinite(snapshot.quote.bestAsk)
      || snapshot.quote.bestBid <= 0
      || snapshot.quote.bestAsk <= 0
      || snapshot.quote.bestBid >= snapshot.quote.bestAsk
    ) {
      issues.add("quote_geometry_invalid");
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
    stateComplete: issues.size === 0,
    issues: [...issues],
    quoteAgeMs,
    stateAgeMs,
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

