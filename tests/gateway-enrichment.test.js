import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBars, summarizeBars } from "../src/gateway/bars.js";
import {
  averageTrueRange,
  buildMarketFeatures,
  lastBarDirection,
} from "../src/gateway/features.js";
import { deriveQuoteFromBars } from "../src/gateway/enrichment.js";
import { buildSetupCandidates } from "../src/gateway/setup.js";
import { buildStructuralLevels } from "../src/gateway/levels.js";
import { summarizeTrades } from "../src/gateway/session-policy.js";

test("normalizeBars maps ProjectX OHLCV", () => {
  const bars = normalizeBars([
    { t: "2026-01-01T10:00:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 10 },
  ]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].c, 100.5);
});

test("buildMarketFeatures computes range position", () => {
  const bars1m = normalizeBars([
    { t: "1", o: 100, h: 110, l: 90, c: 105, v: 100 },
    { t: "2", o: 105, h: 108, l: 104, c: 106, v: 120 },
    { t: "3", o: 106, h: 109, l: 105, c: 108, v: 90 },
  ]);
  const features = buildMarketFeatures({
    bars1m,
    bars5m: bars1m,
    quote: {
      last: 108,
      session_open: 100,
      session_high: 110,
      session_low: 90,
    },
    tickSize: 0.25,
  });
  assert.equal(features.position_in_range, 0.9);
  assert.equal(features.last_3_bar_direction, "up");
});

test("deriveQuoteFromBars uses realtime quote when present", () => {
  const quote = deriveQuoteFromBars(
    { tickSize: 0.25 },
    normalizeBars([{ t: "1", o: 100, h: 101, l: 99, c: 100, v: 1 }]),
    { last: 101, bid: 100.75, ask: 101.25, quote_timestamp: "rt" },
  );
  assert.equal(quote.last, 101);
  assert.equal(quote.source, "realtime");
});

test("summarizeTrades aggregates pnl", () => {
  const summary = summarizeTrades([
    {
      creationTimestamp: "2026-01-01T10:00:00Z",
      profitAndLoss: 25,
      fees: 1.4,
      voided: false,
    },
    {
      creationTimestamp: "2026-01-01T10:05:00Z",
      profitAndLoss: -10,
      fees: 1.4,
      voided: false,
    },
  ]);
  assert.equal(summary.realized_pnl_usd, 15);
  assert.equal(summary.net_pnl_usd, 12.2);
});

test("buildSetupCandidates returns structural entries", () => {
  const market = {
    last: 100,
    bid: 99.75,
    ask: 100.25,
    session: { low: 90, high: 110 },
    features: { regime_1m: "trend", atr_14_1m: 2 },
    levels: { nearest_support: 95, nearest_resistance: 105 },
  };
  const candidates = buildSetupCandidates({
    market,
    positionState: { side: "flat" },
    policy: { allowed_risk_usd: 50, daily_loss_remaining_usd: 500 },
    contract: { tickSize: 0.25, tickValue: 0.5 },
    protection: { stop_confirmed: true },
  });
  assert.ok(candidates.length >= 1);
});

test("buildStructuralLevels finds nearest support and resistance", () => {
  const bars1m = normalizeBars([
    { t: "1", o: 100, h: 105, l: 98, c: 104, v: 10 },
    { t: "2", o: 104, h: 106, l: 99, c: 105, v: 10 },
    { t: "3", o: 105, h: 107, l: 100, c: 106, v: 10 },
  ]);
  const levels = buildStructuralLevels({
    bars1m,
    bars5m: bars1m,
    features: { vwap_session: 103 },
    quote: { last: 106, session_open: 100, session_high: 110, session_low: 98 },
  });
  assert.ok(levels.nearest_support <= 106);
  assert.ok(levels.nearest_resistance >= 106);
});

test("summarizeBars reports direction", () => {
  const summary = summarizeBars(
    normalizeBars([
      { t: "1", o: 100, h: 101, l: 99, c: 100, v: 1 },
      { t: "2", o: 100, h: 103, l: 100, c: 102, v: 1 },
    ]),
  );
  assert.equal(summary.direction, "up");
});
