import type {
  CanonicalBar,
  MultiTimeframeObservation,
  TimeframeObservation,
} from "../domain/market-observation.js";
import {
  calculateFeatures,
  findGaps,
  normalizeBars,
} from "./observation.js";

const TIMEFRAMES = [1, 5, 15, 60] as const;
const MINUTE_MS = 60_000;

export interface BuildTimeframeSeriesObservationInput {
  instrument: string;
  contractId: string;
  series: Partial<Record<1 | 5 | 15 | 60, CanonicalBar[]>>;
  source?: "projectx_bars" | "replay";
  now?: Date;
}

export function buildObservationFromTimeframeSeries(
  input: BuildTimeframeSeriesObservationInput,
): MultiTimeframeObservation {
  const now = input.now ?? new Date();
  let rejectedBarCount = 0;
  const observations: TimeframeObservation[] = [];

  for (const timeframeMinutes of TIMEFRAMES) {
    const received = input.series[timeframeMinutes] ?? [];
    const accepted = normalizeBars(received);
    rejectedBarCount += received.length - accepted.length;
    const latest = accepted.at(-1) ?? null;
    observations.push({
      timeframeMinutes,
      barsAvailable: accepted.length,
      latestBarUtc: latest?.timestamp ?? null,
      latestBarPartial: latest === null
        ? false
        : latest.epochMs + timeframeMinutes * MINUTE_MS > now.getTime(),
      gaps: findGaps(accepted, timeframeMinutes),
      features: latest === null ? null : calculateFeatures(accepted),
    });
  }

  const oneMinuteReceived = input.series[1]?.length ?? 0;
  const oneMinuteAccepted = normalizeBars(input.series[1] ?? []).length;
  return {
    schema_version: "glitch.market_observation.v1",
    generated_utc: now.toISOString(),
    source: input.source ?? "projectx_bars",
    instrument: input.instrument,
    contract_id: input.contractId,
    one_minute_bars_received: oneMinuteReceived,
    one_minute_bars_accepted: oneMinuteAccepted,
    rejected_bar_count: rejectedBarCount,
    timeframes: observations,
  };
}
