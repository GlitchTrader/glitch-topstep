import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalBar } from "../src/domain/market-observation.js";
import {
  aggregateBars,
  buildMultiTimeframeObservation,
  normalizeBars,
} from "../src/market/observation.js";

function bars(count: number, start = Date.parse("2026-07-21T12:00:00Z")): CanonicalBar[] {
  return Array.from({ length: count }, (_, index) => {
    const open = 20_000 + index;
    const close = open + (index % 2 === 0 ? 0.5 : -0.25);
    return {
      timestamp: new Date(start + index * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + index,
    };
  });
}

describe("multi-timeframe market observation", () => {
  it("sorts bars, rejects invalid geometry, and counts duplicate replacement", () => {
    const valid = bars(3);
    const normalized = normalizeBars([
      valid[2]!,
      valid[0]!,
      {
        ...valid[1]!,
        high: valid[1]!.low - 1,
      },
      valid[0]!,
    ]);
    assert.equal(normalized.length, 2);
    assert.deepEqual(
      normalized.map((bar) => bar.timestamp),
      [valid[0]!.timestamp, valid[2]!.timestamp],
    );
  });

  it("aggregates aligned OHLCV without inventing intermediate prices", () => {
    const minuteBars = normalizeBars(bars(5));
    const [fiveMinute] = aggregateBars(minuteBars, 5);
    assert.ok(fiveMinute);
    assert.equal(fiveMinute.open, minuteBars[0]!.open);
    assert.equal(fiveMinute.close, minuteBars[4]!.close);
    assert.equal(fiveMinute.high, Math.max(...minuteBars.map((bar) => bar.high)));
    assert.equal(fiveMinute.low, Math.min(...minuteBars.map((bar) => bar.low)));
    assert.equal(
      fiveMinute.volume,
      minuteBars.reduce((total, bar) => total + bar.volume, 0),
    );
  });

  it("publishes 1m 5m 15m and 60m evidence with explicit gaps and partial bars", () => {
    const input = bars(61);
    input.splice(10, 1);
    const observation = buildMultiTimeframeObservation({
      instrument: "MNQ",
      contractId: "CON.F.US.MNQ.U26",
      bars: input,
      now: new Date("2026-07-21T13:00:30Z"),
    });

    assert.deepEqual(
      observation.timeframes.map((timeframe) => timeframe.timeframeMinutes),
      [1, 5, 15, 60],
    );
    assert.equal(observation.timeframes[0]?.gaps[0]?.missingBars, 1);
    assert.equal(observation.timeframes[0]?.latestBarPartial, true);
    assert.equal(observation.timeframes[3]?.barsAvailable, 2);
    assert.equal(observation.rejected_bar_count, 0);
  });

  it("emits descriptive features without a signal or trade recommendation", () => {
    const observation = buildMultiTimeframeObservation({
      instrument: "MNQ",
      contractId: "CON.F.US.MNQ.U26",
      bars: bars(240),
      source: "replay",
      now: new Date("2026-07-21T16:00:00Z"),
    });
    const oneMinute = observation.timeframes[0]!;
    assert.ok(oneMinute.features?.averageTrueRange14);
    assert.ok(oneMinute.features?.rollingVwap20);
    assert.ok(oneMinute.features?.ema20);
    assert.ok(oneMinute.features?.ema50);
    assert.ok(oneMinute.features?.ema200);
    assert.equal("signal" in (oneMinute.features ?? {}), false);
    assert.equal("score" in (oneMinute.features ?? {}), false);
    assert.equal("action" in (oneMinute.features ?? {}), false);
  });

  it("keeps flat bars finite and marks undefined ratios as null", () => {
    const flat = Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(Date.parse("2026-07-21T12:00:00Z") + index * 60_000).toISOString(),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    }));
    const features = buildMultiTimeframeObservation({
      instrument: "TEST",
      contractId: "TEST",
      bars: flat,
      now: new Date("2026-07-21T12:20:00Z"),
    }).timeframes[0]!.features!;
    assert.equal(features.closeLocation, null);
    assert.equal(features.bodyFraction, null);
    assert.equal(features.rollingVwap20, null);
    assert.equal(features.volumeZScore20, null);
  });
});
