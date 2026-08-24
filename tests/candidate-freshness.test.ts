import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUniverseFreshness,
  observationAgeMs,
  PACKET_OBSERVATION_STALE_MS,
  RANKING_FRESHNESS_MAX_SKEW_MS,
} from "../src/market/candidate-freshness.js";

test("observation refresh threshold stays aligned with ranking skew threshold", () => {
  assert.equal(PACKET_OBSERVATION_STALE_MS, RANKING_FRESHNESS_MAX_SKEW_MS);
  assert.equal(PACKET_OBSERVATION_STALE_MS, 30_000);
});

test("buildUniverseFreshness marks skew invalid beyond threshold", () => {
  const asOf = new Date("2026-08-21T14:50:12.433Z");
  const fresh = buildUniverseFreshness([1_000, 5_000, 8_000], asOf);
  assert.equal(fresh.ranking_freshness_skew_ms, 7_000);
  assert.equal(fresh.ranking_freshness_valid, true);

  const atLimit = buildUniverseFreshness([0, RANKING_FRESHNESS_MAX_SKEW_MS], asOf);
  assert.equal(atLimit.ranking_freshness_skew_ms, RANKING_FRESHNESS_MAX_SKEW_MS);
  assert.equal(atLimit.ranking_freshness_valid, true);

  const stale = buildUniverseFreshness([0, RANKING_FRESHNESS_MAX_SKEW_MS + 1], asOf);
  assert.equal(stale.ranking_freshness_skew_ms, RANKING_FRESHNESS_MAX_SKEW_MS + 1);
  assert.equal(stale.ranking_freshness_valid, false);
  assert.ok(stale.ranking_freshness_skew_ms! > RANKING_FRESHNESS_MAX_SKEW_MS);
});

test("observationAgeMs returns null without a successful refresh timestamp", () => {
  assert.equal(
    observationAgeMs({
      last_attempt_utc: null,
      last_succeeded_utc: null,
      last_error: null,
      observation: null,
    }, Date.parse("2026-08-21T14:50:12.433Z")),
    null,
  );
});
