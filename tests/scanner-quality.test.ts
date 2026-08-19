import assert from "node:assert/strict";
import test from "node:test";
import { summarizeScannerObservation } from "../src/market/scanner-quality.js";

const base = {
  last_attempt_utc: "2026-08-19T17:00:00.000Z",
  last_succeeded_utc: "2026-08-19T17:00:00.000Z",
  last_error: null,
  observation: {
    schema_version: "glitch.projectx.market_observation.v1" as const,
    generated_utc: "2026-08-19T17:00:00.000Z",
    source: "projectx_bars" as const,
    instrument: "MNQ",
    contract_id: "CON.F.US.MNQ.U26",
    timeframes: [1, 5].map((timeframe_minutes) => ({
      timeframe_minutes: timeframe_minutes as 1 | 5,
      bars_received: 500,
      bars_accepted: 500,
      rejected_bars: 0,
      latest_bar_utc: "2026-08-19T17:00:00.000Z",
      latest_bar_partial: true,
      current_partial_bar: null,
      prior_completed_bar: {
        timestamp: "2026-08-19T16:59:00.000Z",
        open: 1,
        high: 2,
        low: 1,
        close: 2,
        volume: 1,
      },
      partial_progress: 0.5,
      bar_identity_issues: [],
      gaps: [],
      features: null,
    })),
  },
};

test("scanner quality is ready only when every timeframe has a completed bar", () => {
  assert.deepEqual(summarizeScannerObservation(base), {
    status: "ready",
    observation_ready: true,
    last_succeeded_utc: "2026-08-19T17:00:00.000Z",
    last_error: null,
    timeframe_count: 2,
    completed_timeframe_count: 2,
    gap_count: 0,
    identity_issue_count: 0,
  });
  const warming = {
    ...base,
    observation: {
      ...base.observation,
      timeframes: base.observation.timeframes.map((timeframe, index) => (
        index === 1 ? { ...timeframe, prior_completed_bar: null } : timeframe
      )),
    },
  };
  assert.equal(summarizeScannerObservation(warming).status, "warming");
  assert.equal(summarizeScannerObservation(warming).observation_ready, false);
});

test("scanner quality reports provider error without inventing a candidate decision", () => {
  const errored = { ...base, last_error: "429:rate_limit" };
  const quality = summarizeScannerObservation(errored);
  assert.equal(quality.status, "error");
  assert.equal(quality.observation_ready, false);
  assert.equal(quality.last_error, "429:rate_limit");
});
