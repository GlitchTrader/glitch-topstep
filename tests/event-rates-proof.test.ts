import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildEventRatesProof,
  buildMinuteBuckets,
  EVENT_RATES_PROOF_SCHEMA,
  totalsFromRows,
  validateEventRatesProof,
  type EventRatesProof,
} from "../src/projectx/event-rates-proof.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "projectx", "live");

function retentionPolicy() {
  return {
    market_event_retention: 500_000,
    market_prune_interval: 10_000,
    maximum_market_events_between_prunes: 509_999,
  };
}

describe("TS-R2-07 event rates proof", () => {
  it("computes per-second quote, print, and depth rates from minute buckets", () => {
    const minuteBuckets = buildMinuteBuckets([
      { minute_utc: "2026-08-03T00:00:00Z", event_type: "quote", count: 120 },
      { minute_utc: "2026-08-03T00:00:00Z", event_type: "market_trade", count: 30 },
      { minute_utc: "2026-08-03T00:00:00Z", event_type: "depth", count: 90 },
      { minute_utc: "2026-08-03T00:01:00Z", event_type: "quote", count: 120 },
      { minute_utc: "2026-08-03T00:01:00Z", event_type: "market_trade", count: 30 },
      { minute_utc: "2026-08-03T00:01:00Z", event_type: "depth", count: 90 },
    ]);
    const totals = totalsFromRows([
      { event_type: "quote", count: 240 },
      { event_type: "market_trade", count: 60 },
      { event_type: "depth", count: 180 },
    ]);
    const proof = buildEventRatesProof({
      capturedUtc: "2026-08-03T01:00:00.000Z",
      mode: "retrospective",
      scope: {
        account_id: 101,
        account_name: "PRAC",
        contract_id: "CON.F.US.MNQ.U26",
        instrument: "MNQ",
      },
      windowStartUtc: "2026-08-03T00:00:00.000Z",
      windowEndUtc: "2026-08-03T00:30:00.000Z",
      durationMinutes: 30,
      retentionPolicy: retentionPolicy(),
      eventTotals: totals,
      minuteBuckets: Array.from({ length: 30 }, (_, index) => ({
        minute_utc: `2026-08-03T00:${String(index).padStart(2, "0")}:00Z`,
        quote: 8,
        market_trade: 2,
        depth: 6,
        market_event_total: 16,
      })),
      diskBytesStart: 100_000,
      diskBytesEnd: 150_000,
      eventCountStart: 1_000,
      eventCountEnd: 1_250,
      peakMarketEventCount: 400_000,
      minimumDurationMinutes: 30,
    });
    assert.equal(proof.schema_version, EVENT_RATES_PROOF_SCHEMA);
    assert.equal(proof.proof_passed, true);
    assert.equal(proof.stream_rates_per_second.quote, 240 / 1800);
    assert.equal(proof.stream_rates_per_second.market_trade, 60 / 1800);
    assert.equal(proof.stream_rates_per_second.depth, 180 / 1800);
    assert.deepEqual(validateEventRatesProof(proof), []);
  });

  it("validates the live event rates proof fixture captured on Windows", () => {
    const fixturePath = path.join(FIXTURE_DIR, "event_rates_proof.json");
    if (!fs.existsSync(fixturePath)) {
      return;
    }
    const proof = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as EventRatesProof;
    const failures = validateEventRatesProof(proof);
    assert.deepEqual(failures, [], failures.join(", "));
    assert.equal(proof.proof_passed, true);
    assert.ok(proof.stream_rates_per_second.quote > 0);
    assert.ok(proof.stream_rates_per_second.market_trade > 0);
    assert.ok(proof.stream_rates_per_second.depth > 0);
    assert.ok(proof.retention_observed.within_policy);
  });
});
