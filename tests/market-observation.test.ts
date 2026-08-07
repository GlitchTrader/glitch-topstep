import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalMarketBar } from "../src/domain/market-observation.js";
import {
  buildMultiTimeframeMarketObservation,
  normalizeMarketBars,
} from "../src/market/observation.js";

function bars(count: number, start = Date.parse("2026-07-21T12:00:00Z")): CanonicalMarketBar[] {
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

describe("strategy-neutral market observation", () => {
  it("sorts, deduplicates, and rejects invalid OHLCV geometry", () => {
    const valid = bars(3);
    const normalized = normalizeMarketBars([
      valid[2]!,
      valid[0]!,
      { ...valid[1]!, high: valid[1]!.low - 1 },
      { ...valid[0]!, close: valid[0]!.close + 0.25 },
    ]);
    assert.equal(normalized.length, 2);
    assert.deepEqual(
      normalized.map((bar) => bar.timestamp),
      [valid[0]!.timestamp, valid[2]!.timestamp],
    );
    assert.equal(normalized[0]?.close, valid[0]!.close + 0.25);
  });

  it("publishes native 1m 5m 15m and 60m evidence with gaps and partial bars", () => {
    const oneMinute = bars(61);
    oneMinute.splice(10, 1);
    const observation = buildMultiTimeframeMarketObservation({
      instrument: "MNQ",
      contractId: "CON.F.US.MNQ.U26",
      now: new Date("2026-07-21T13:00:30Z"),
      series: {
        1: oneMinute,
        5: bars(20),
        15: bars(20),
        60: bars(20),
      },
    });
    assert.deepEqual(
      observation.timeframes.map((timeframe) => timeframe.timeframe_minutes),
      [1, 5, 15, 60],
    );
    assert.equal(observation.timeframes[0]?.gaps[0]?.missing_bars, 1);
    assert.equal(observation.timeframes[0]?.latest_bar_partial, true);
    assert.equal(observation.timeframes[0]?.rejected_bars, 0);
    assert.ok(
      observation.timeframes[0]?.features?.progress_adjusted_volume_z_score_20 !== undefined,
    );
  });

  it("emits descriptive features without a signal, score, or action", () => {
    const observation = buildMultiTimeframeMarketObservation({
      instrument: "MNQ",
      contractId: "CON.F.US.MNQ.U26",
      source: "replay",
      now: new Date("2026-07-21T16:00:00Z"),
      series: {
        1: bars(240),
        5: bars(240),
        15: bars(240),
        60: bars(240),
      },
    });
    const features = observation.timeframes[0]!.features!;
    assert.ok(features.average_true_range_14);
    assert.ok(features.rolling_vwap_20);
    assert.ok(features.ema_20);
    assert.ok(features.ema_50);
    assert.ok(features.ema_200);
    assert.equal("signal" in features, false);
    assert.equal("score" in features, false);
    assert.equal("action" in features, false);
  });

  it("keeps undefined flat-bar ratios explicit as null", () => {
    const flat = Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(Date.parse("2026-07-21T12:00:00Z") + index * 60_000).toISOString(),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    }));
    const features = buildMultiTimeframeMarketObservation({
      instrument: "TEST",
      contractId: "TEST",
      now: new Date("2026-07-21T12:20:00Z"),
      series: { 1: flat },
    }).timeframes[0]!.features!;
    assert.equal(features.close_location, null);
    assert.equal(features.body_fraction, null);
    assert.equal(features.rolling_vwap_20, null);
    assert.equal(features.volume_z_score_20, null);
  });
});
