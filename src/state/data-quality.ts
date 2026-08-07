import type { AccountVenueSnapshot, RiskSettings } from "../domain/models.js";

export interface SnapshotDataQuality {
  stateComplete: boolean;
  issues: string[];
  quoteAgeMs: number | null;
  stateAgeMs: number | null;
}

const FUTURE_TOLERANCE_MS = 2_000;
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
      issues.add("quote_clock_skew");
      quoteAgeMs = 0;
    } else if (quoteAgeMs > settings.maxQuoteAgeMs) {
      issues.add("quote_stale");
    }
  }

  if (stateAgeMs === null) {
    issues.add("account_state_timestamp_invalid");
  } else if (stateAgeMs < -FUTURE_TOLERANCE_MS) {
    issues.add("account_state_timestamp_future");
  } else if (stateAgeMs > settings.maxStateAgeMs && !reconciliationInFlightGrace(snapshot, now)) {
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

function reconciliationInFlightGrace(snapshot: AccountVenueSnapshot, now: Date): boolean {
  const reconciliation = snapshot.operational?.reconciliation;
  if (reconciliation?.state !== "running" || !reconciliation.lastStartedAt) {
    return false;
  }
  const startedAgeMs = ageMilliseconds(reconciliation.lastStartedAt, now);
  return startedAgeMs !== null
    && startedAgeMs >= 0
    && startedAgeMs <= RECONCILIATION_STALE_GRACE_MS;
}
