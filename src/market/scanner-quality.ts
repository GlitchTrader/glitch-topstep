import type { MarketObservationState } from "../domain/market-observation.js";

export type ScannerObservationStatus = "ready" | "warming" | "stale" | "error";

export interface ScannerObservationQuality {
  status: ScannerObservationStatus;
  observation_ready: boolean;
  last_succeeded_utc: string | null;
  last_error: string | null;
  timeframe_count: number;
  completed_timeframe_count: number;
  gap_count: number;
  identity_issue_count: number;
}

/**
 * Describes data quality only. It intentionally does not score direction,
 * confidence, profitability, or whether Hermes should trade.
 */
export function summarizeScannerObservation(
  state: MarketObservationState,
): ScannerObservationQuality {
  if (state.last_error) {
    return {
      status: "error",
      observation_ready: false,
      last_succeeded_utc: state.last_succeeded_utc,
      last_error: state.last_error,
      timeframe_count: state.observation?.timeframes.length ?? 0,
      completed_timeframe_count: 0,
      gap_count: 0,
      identity_issue_count: 0,
    };
  }
  const timeframes = state.observation?.timeframes ?? [];
  const completed = timeframes.filter((timeframe) => timeframe.prior_completed_bar !== null).length;
  const gapCount = timeframes.reduce((total, timeframe) => total + timeframe.gaps.length, 0);
  const identityIssueCount = timeframes.reduce(
    (total, timeframe) => total + timeframe.bar_identity_issues.length,
    0,
  );
  const ready = timeframes.length > 0
    && completed === timeframes.length
    && identityIssueCount === 0;
  return {
    status: ready ? "ready" : (state.observation ? "warming" : "stale"),
    observation_ready: ready,
    last_succeeded_utc: state.last_succeeded_utc,
    last_error: state.last_error,
    timeframe_count: timeframes.length,
    completed_timeframe_count: completed,
    gap_count: gapCount,
    identity_issue_count: identityIssueCount,
  };
}
