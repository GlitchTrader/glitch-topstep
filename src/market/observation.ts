import type {
  BarGap,
  CanonicalBar,
  DescriptiveMarketFeatures,
  MultiTimeframeObservation,
  TimeframeObservation,
} from "../domain/market-observation.js";

const TIMEFRAMES = [1, 5, 15, 60] as const;
const MINUTE_MS = 60_000;
const EPSILON = 1e-12;

export interface BuildObservationInput {
  instrument: string;
  contractId: string;
  bars: CanonicalBar[];
  source?: "projectx_bars" | "replay";
  now?: Date;
}

interface AcceptedBar extends CanonicalBar {
  epochMs: number;
}

export function buildMultiTimeframeObservation(
  input: BuildObservationInput,
): MultiTimeframeObservation {
  const now = input.now ?? new Date();
  const accepted = normalizeBars(input.bars);
  const rejectedBarCount = input.bars.length - accepted.length;

  return {
    schema_version: "glitch.market_observation.v1",
    generated_utc: now.toISOString(),
    source: input.source ?? "projectx_bars",
    instrument: input.instrument,
    contract_id: input.contractId,
    one_minute_bars_received: input.bars.length,
    one_minute_bars_accepted: accepted.length,
    rejected_bar_count: rejectedBarCount,
    timeframes: TIMEFRAMES.map((timeframeMinutes) => {
      const bars = timeframeMinutes === 1
        ? accepted
        : aggregateBars(accepted, timeframeMinutes);
      return observeTimeframe(bars, timeframeMinutes, now.getTime());
    }),
  };
}

export function normalizeBars(input: CanonicalBar[]): AcceptedBar[] {
  const unique = new Map<number, AcceptedBar>();
  for (const bar of input) {
    const epochMs = Date.parse(bar.timestamp);
    if (!isValidBar(bar, epochMs)) {
      continue;
    }
    unique.set(epochMs, {
      timestamp: new Date(epochMs).toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      epochMs,
    });
  }
  return [...unique.values()].sort((left, right) => left.epochMs - right.epochMs);
}

export function aggregateBars(
  bars: AcceptedBar[],
  timeframeMinutes: 5 | 15 | 60,
): AcceptedBar[] {
  const bucketMs = timeframeMinutes * MINUTE_MS;
  const buckets = new Map<number, AcceptedBar>();
  for (const bar of bars) {
    const bucketStart = Math.floor(bar.epochMs / bucketMs) * bucketMs;
    const current = buckets.get(bucketStart);
    if (!current) {
      buckets.set(bucketStart, {
        timestamp: new Date(bucketStart).toISOString(),
        epochMs: bucketStart,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume += bar.volume;
  }
  return [...buckets.values()].sort((left, right) => left.epochMs - right.epochMs);
}

function observeTimeframe(
  bars: AcceptedBar[],
  timeframeMinutes: 1 | 5 | 15 | 60,
  nowMs: number,
): TimeframeObservation {
  const latest = bars.at(-1) ?? null;
  return {
    timeframeMinutes,
    barsAvailable: bars.length,
    latestBarUtc: latest?.timestamp ?? null,
    latestBarPartial: latest === null
      ? false
      : latest.epochMs + timeframeMinutes * MINUTE_MS > nowMs,
    gaps: findGaps(bars, timeframeMinutes),
    features: latest === null ? null : calculateFeatures(bars),
  };
}

export function findGaps(
  bars: AcceptedBar[],
  timeframeMinutes: 1 | 5 | 15 | 60,
): BarGap[] {
  const expectedMs = timeframeMinutes * MINUTE_MS;
  const gaps: BarGap[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1]!;
    const current = bars[index]!;
    const difference = current.epochMs - previous.epochMs;
    if (difference <= expectedMs) {
      continue;
    }
    gaps.push({
      afterUtc: previous.timestamp,
      beforeUtc: current.timestamp,
      missingBars: Math.max(1, Math.round(difference / expectedMs) - 1),
    });
  }
  return gaps;
}

export function calculateFeatures(
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

  const ema20Series = exponentialMovingAverage(bars.map((bar) => bar.close), 20);
  const ema50Series = exponentialMovingAverage(bars.map((bar) => bar.close), 50);
  const ema200Series = exponentialMovingAverage(bars.map((bar) => bar.close), 200);
  const ema20 = ema20Series.at(-1) ?? null;
  const ema50 = ema50Series.at(-1) ?? null;
  const ema200 = ema200Series.at(-1) ?? null;
  const rollingVwap20 = calculateRollingVwap(bars, 20);

  return {
    latestClose: latest.close,
    change,
    returnBps,
    trueRange,
    averageTrueRange14: averageTrueRange(bars, 14),
    realizedVolatility20Bps: realizedVolatilityBps(bars, 20),
    rollingVwap20,
    distanceFromRollingVwap20Bps: rollingVwap20 === null
      ? null
      : basisPoints(latest.close, rollingVwap20),
    ema20,
    ema50,
    ema200,
    distanceFromEma20Bps: ema20 === null ? null : basisPoints(latest.close, ema20),
    distanceFromEma50Bps: ema50 === null ? null : basisPoints(latest.close, ema50),
    distanceFromEma200Bps: ema200 === null ? null : basisPoints(latest.close, ema200),
    ema20SlopeBps: movingAverageSlopeBps(ema20Series),
    ema50SlopeBps: movingAverageSlopeBps(ema50Series),
    ema200SlopeBps: movingAverageSlopeBps(ema200Series),
    rangePosition20: rangePosition(bars, 20),
    closeLocation: range <= EPSILON ? null : clamp01((latest.close - latest.low) / range),
    bodyFraction: range <= EPSILON ? null : Math.abs(latest.close - latest.open) / range,
    upperWickFraction: range <= EPSILON
      ? null
      : (latest.high - Math.max(latest.open, latest.close)) / range,
    lowerWickFraction: range <= EPSILON
      ? null
      : (Math.min(latest.open, latest.close) - latest.low) / range,
    volumeZScore20: zScore(bars.map((bar) => bar.volume), 20),
  };
}

function isValidBar(bar: CanonicalBar, epochMs: number): boolean {
  if (!Number.isFinite(epochMs)) {
    return false;
  }
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume];
  if (values.some((value) => !Number.isFinite(value))) {
    return false;
  }
  if (bar.volume < 0) {
    return false;
  }
  if (bar.high < Math.max(bar.open, bar.close, bar.low)) {
    return false;
  }
  if (bar.low > Math.min(bar.open, bar.close, bar.high)) {
    return false;
  }
  return true;
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

function calculateRollingVwap(bars: AcceptedBar[], period: number): number | null {
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
  const output: number[] = [];
  let current = mean(values.slice(0, period));
  output.push(current);
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index]! - current) * multiplier + current;
    output.push(current);
  }
  return output;
}

function movingAverageSlopeBps(series: number[]): number | null {
  if (series.length < 2) {
    return null;
  }
  return basisPoints(series.at(-1)!, series.at(-2)!);
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
  const variance = values.reduce(
    (total, value) => total + (value - average) ** 2,
    0,
  ) / values.length;
  return Math.sqrt(variance);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
