import type { MarketObservationState } from "../domain/market-observation.js";
import type { QuoteInfo } from "../domain/models.js";

export const RANKING_FRESHNESS_MAX_SKEW_MS = 30_000;
// ponytail: must stay <= RANKING_FRESHNESS_MAX_SKEW_MS. Refreshing MES/MCL only after
// 45s while skew invalidated at 30s produced overnight ranking_freshness_valid=false
// in the 30–45s band (MNQ refreshed every packet, secondaries left behind).
export const PACKET_OBSERVATION_STALE_MS = RANKING_FRESHNESS_MAX_SKEW_MS;
export const TIMEFRAMES_PER_INSTRUMENT = 4;

export interface CandidateAlignmentPacket {
  observation_age_ms: number | null;
  quote_age_ms: number | null;
  latest_1m_age_ms: number | null;
  comparable_as_of_utc: string;
  ranking_freshness_valid: boolean;
}

export interface UniverseFreshnessPacket {
  comparable_as_of_utc: string;
  ranking_freshness_skew_ms: number | null;
  ranking_freshness_valid: boolean;
}

export function observationAgeMs(
  state: MarketObservationState,
  asOfMs: number,
): number | null {
  if (!state.last_succeeded_utc) {
    return null;
  }
  const succeededMs = Date.parse(state.last_succeeded_utc);
  if (!Number.isFinite(succeededMs)) {
    return null;
  }
  return Math.max(0, asOfMs - succeededMs);
}

export function quoteAgeMs(quote: QuoteInfo | null | undefined, asOfMs: number): number | null {
  if (!quote?.timestamp) {
    return null;
  }
  const quoteMs = Date.parse(quote.timestamp);
  if (!Number.isFinite(quoteMs)) {
    return null;
  }
  return Math.max(0, asOfMs - quoteMs);
}

export function latest1mBarAgeMs(
  state: MarketObservationState,
  asOfMs: number,
): number | null {
  const tf1 = state.observation?.timeframes.find((row) => row.timeframe_minutes === 1);
  if (!tf1?.latest_bar_utc) {
    return null;
  }
  const barMs = Date.parse(tf1.latest_bar_utc);
  if (!Number.isFinite(barMs)) {
    return null;
  }
  return Math.max(0, asOfMs - barMs);
}

export function buildCandidateAlignment(
  state: MarketObservationState,
  quote: QuoteInfo | null | undefined,
  asOf: Date,
  rankingFreshnessValid: boolean,
): CandidateAlignmentPacket {
  const asOfMs = asOf.getTime();
  return {
    observation_age_ms: observationAgeMs(state, asOfMs),
    quote_age_ms: quoteAgeMs(quote, asOfMs),
    latest_1m_age_ms: latest1mBarAgeMs(state, asOfMs),
    comparable_as_of_utc: asOf.toISOString(),
    ranking_freshness_valid: rankingFreshnessValid,
  };
}

export function buildUniverseFreshness(
  observationAgesMs: Array<number | null>,
  asOf: Date,
): UniverseFreshnessPacket {
  const defined = observationAgesMs.filter((value): value is number => value !== null);
  const skew = defined.length >= 2
    ? Math.max(...defined) - Math.min(...defined)
    : null;
  return {
    comparable_as_of_utc: asOf.toISOString(),
    ranking_freshness_skew_ms: skew,
    ranking_freshness_valid: skew === null || skew <= RANKING_FRESHNESS_MAX_SKEW_MS,
  };
}
