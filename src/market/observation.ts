import type {
  CanonicalMarketBar,
  DescriptiveMarketFeatures,
  MarketBarGap,
  MarketObservationTimeframeMinutes,
  MultiTimeframeMarketObservation,
  TimeframeMarketObservation,
} from "../domain/market-observation.js";

const TIMEFRAMES: MarketObservationTimeframeMinutes[] = [1, 5, 15, 60];
const MINUTE_MS = 60_000;
const EPSILON = 1e-12;

interface AcceptedBar extends CanonicalMarketBar {
  epochMs: number;
}

export interface BuildMarketObservationInput {
  instrument: string;
  contractId: string;
  series: Partial<Record<MarketObservationTimeframeMinutes, CanonicalMarketBar[]>>;
  source?: "projectx_bars" | "replay";
  now?: Date;
}

export function buildMultiTimeframeMarketObservation(
  input: BuildMarketObservationInput,
): MultiTimeframeMarketObservation {
  const now = input.now ?? new Date();
  return {
    schema_version: "glitch.projectx.market_observation.v1",
    generated_utc: now.toISOString(),
    source: input.source ?? "projectx_bars",
    instrument: input.instrument,
    contract_id: input.contractId,
    timeframes: TIMEFRAMES.map((timeframe) => observeTimeframe(
      input.series[timeframe] ?? [],
      timeframe,
      now.getTime(),
    )),
  };
}

export function normalizeMarketBars(input: CanonicalMarketBar[]): AcceptedBar[] {
  const unique = new Map<number, AcceptedBar>();
  for (const bar of input) {
    const epochMs = Date.parse(bar.timestamp);
    if (!isValidBar(bar, epochMs)) {
      continue;
    }
    unique.set(epochMs, {
      ...bar,
      timestamp: new Date(epochMs).toISOString(),
      epochMs,
    });
  }
  return [...unique.values()].sort((left, right) => left.epochMs - right.epochMs);
}

export function findMarketBarGaps(
  bars: AcceptedBar[],
  timeframeMinutes: MarketObservationTimeframeMinutes,
): MarketBarGap[] {
  const expectedMs = timeframeMinutes * MINUTE_MS;
  const gaps: MarketBarGap[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1]!;
    const current = bars[index]!;
    const difference = current.epochMs - previous.epochMs;
    if (difference <= expectedMs) {
      continue;
    }
    gaps.push({
      after_utc: previous.timestamp,
      before_utc: current.timestamp,
      missing_bars: Math.max(1, Math.round(difference / expectedMs) - 1),
    });
  }
  return gaps;
}

export function calculateDescriptiveMarketFeatures(
  bars: AcceptedBar[],
): DescriptiveMarketFeatures {
  const latest = bars.at(-1)!;
  const previous = bars.at(-2) ?? null;
  const range = latest.high - latest.low;
  const change = previous ? latest.close - previous.close : null;
  const returnBps = previous ? basisPoints(latest.close, previous.close) : null;
  const trueRange = previous
    ? Math.max(
        range,
        Math.abs(latest.high - previous.close),
        Math.abs(latest.low - previous.close),
      )
    : range;
  const closeValues = bars.map((bar) => bar.close);
  const ema20Series = exponentialMovingAverage(closeValues, 20);
  const ema50Series = exponentialMovingAverage(closeValues, 50);
  const ema200Series = exponentialMovingAverage(closeValues, 200);
  const ema20 = ema20Series.at(-1) ?? null;
  const ema50 = ema50Series.at(-1) ?? null;
  const ema200 = ema200Series.at(-1) ?? null;
  const rollingVwap20 = rollingVwap(bars, 20);

  return {
    latest_close: latest.close,
    change,
    return_bps: returnBps,
    true_range: trueRange,
    average_true_range_14: averageTrueRange(bars, 14),
    realized_volatility_20_bps: realizedVolatilityBps(bars, 20),
    rolling_vwap_20: rollingVwap20,
    distance_from_rolling_vwap_20_bps:
      rollingVwap20 === null ? null : basisPoints(latest.close, rollingVwap20),
    ema_20: ema20,
    ema_50: ema50,
    ema_200: ema200,
    distance_from_ema_20_bps: ema20 === null ? null : basisPoints(latest.close, ema20),
    distance_from_ema_50_bps: ema50 === null ? null : basisPoints(latest.close, ema50),
    distance_from_ema_200_bps: ema200 === null ? null : basisPoints(latest.close, ema200),
    ema_20_slope_bps: movingAverageSlopeBps(ema20Series),
    ema_50_slope_bps: movingAverageSlopeBps(ema50Series),
    ema_200_slope_bps: movingAverageSlopeBps(ema200Series),
    range_position_20: rangePosition(bars, 20),
    close_location: range <= EPSILON ? null : clamp01((latest.close - latest.low) / range),
    body_fraction: range <= EPSILON ? null : Math.abs(latest.close - latest.open) / range,
    upper_wick_fraction: range <= EPSILON
      ? null
      : (latest.high - Math.max(latest.open, latest.close)) / range,
    lower_wick_fraction: range <= EPSILON
      ? null
      : (Math.min(latest.open, latest.close) - latest.low) / range,
    volume_z_score_20: zScore(bars.map((bar) => bar.volume), 20),
  };
}

function observeTimeframe(
  input: CanonicalMarketBar[],
  timeframeMinutes: MarketObservationTimeframeMinutes,
  nowMs: number,
): TimeframeMarketObservation {
  const accepted = normalizeMarketBars(input);
  const latest = accepted.at(-1) ?? null;
  return {
    timeframe_minutes: timeframeMinutes,
    bars_received: input.length,
    bars_accepted: accepted.length,
    rejected_bars: input.length - accepted.length,
    latest_bar_utc: latest?.timestamp ?? null,
    latest_bar_partial: latest === null
      ? false
      : latest.epochMs + timeframeMinutes * MINUTE_MS > nowMs,
    gaps: findMarketBarGaps(accepted, timeframeMinutes),
    features: latest === null ? null : calculateDescriptiveMarketFeatures(accepted),
  };
}

function isValidBar(bar: CanonicalMarketBar, epochMs: number): boolean {
  if (!Number.isFinite(epochMs)) {
    return false;
  }
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume];
  if (values.some((value) => !Number.isFinite(value)) || bar.volume < 0) {
    return false;
  }
  return bar.high >= Math.max(bar.open, bar.close, bar.low)
    && bar.low <= Math.min(bar.open, bar.close, bar.high);
}

function averageTrueRange(bars: AcceptedBar[], period: number): number | null {
  if (bars.length < period + 1) {
    return null;
  }
  const ranges: number[] = [];
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const current = bars[index]!;
    const previous = bars[index - 1]!;
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return mean(ranges);
}

function realizedVolatilityBps(bars: AcceptedBar[], period: number): number | null {
  if (bars.length < period + 1) {
    return null;
  }
  const returns: number[] = [];
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const current = bars[index]!;
    const previous = bars[index - 1]!;
    const denominator = Math.abs(previous.close);
    if (denominator <= EPSILON) {
      return null;
    }
    returns.push(((current.close - previous.close) / denominator) * 10_000);
  }
  return standardDeviation(returns);
}

function rollingVwap(bars: AcceptedBar[], period: number): number | null {
  if (bars.length < period) {
    return null;
  }
  const window = bars.slice(-period);
  const volume = window.reduce((total, bar) => total + bar.volume, 0);
  if (volume <= EPSILON) {
    return null;
  }
  return window.reduce(
    (total, bar) => total + ((bar.high + bar.low + bar.close) / 3) * bar.volume,
    0,
  ) / volume;
}

function exponentialMovingAverage(values: number[], period: number): number[] {
  if (values.length < period) {
    return [];
  }
  let current = mean(values.slice(0, period));
  const output = [current];
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index]! - current) * multiplier + current;
    output.push(current);
  }
  return output;
}

function movingAverageSlopeBps(series: number[]): number | null {
  return series.length < 2 ? null : basisPoints(series.at(-1)!, series.at(-2)!);
}

function rangePosition(bars: AcceptedBar[], period: number): number | null {
  if (bars.length < period) {
    return null;
  }
  const window = bars.slice(-period);
  const high = Math.max(...window.map((bar) => bar.high));
  const low = Math.min(...window.map((bar) => bar.low));
  const range = high - low;
  return range <= EPSILON ? null : clamp01((window.at(-1)!.close - low) / range);
}

function zScore(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const window = values.slice(-period);
  const average = mean(window);
  const deviation = standardDeviation(window);
  return deviation <= EPSILON ? null : (window.at(-1)! - average) / deviation;
}

function basisPoints(value: number, reference: number): number | null {
  const denominator = Math.abs(reference);
  return denominator <= EPSILON ? null : ((value - reference) / denominator) * 10_000;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  return Math.sqrt(
    values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length,
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
