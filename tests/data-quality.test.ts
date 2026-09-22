import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RiskSettings } from "../src/domain/models.js";
import {
  dataQualityHealthFields,
  evaluateSnapshotDataQuality,
  resetQuoteGeometryTelemetryRetentionForTest,
} from "../src/state/data-quality.js";
import { snapshot } from "./fixtures.js";

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

afterEach(() => {
  resetQuoteGeometryTelemetryRetentionForTest();
});

describe("snapshot data quality", () => {
  it("reports one factual freshness result for healthy state", () => {
    const result = evaluateSnapshotDataQuality(
      snapshot(),
      settings,
      new Date("2026-07-21T12:00:05Z"),
    );
    assert.equal(result.stateComplete, true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.quoteAgeMs, 1_000);
    assert.equal(result.stateAgeMs, 1_000);
  });

  it("reports stale quote and account state without changing source state", () => {
    const current = snapshot();
    current.operational.reconciliation.lastSucceededAt = "2026-07-21T11:59:00Z";
    const result = evaluateSnapshotDataQuality(
      current,
      settings,
      new Date("2026-07-21T12:00:10Z"),
    );
    assert.equal(result.stateComplete, false);
    assert.ok(result.issues.includes("quote_stale"));
    assert.ok(result.issues.includes("account_state_stale"));
  });

  it("does not mark account state stale while reconciliation is in flight", () => {
    const current = snapshot();
    current.operational.reconciliation = {
      state: "running",
      generation: 1,
      lastStartedAt: "2026-07-21T12:00:08Z",
      lastSucceededAt: "2026-07-21T12:00:04Z",
      lastError: null,
    };
    const result = evaluateSnapshotDataQuality(
      current,
      settings,
      new Date("2026-07-21T12:00:10Z"),
    );
    assert.equal(result.stateAgeMs, 6_000);
    assert.ok(!result.issues.includes("account_state_stale"));
    assert.ok(result.issues.includes("quote_stale"));
  });

  it("accepts a recent successful reconciliation during the freshness grace", () => {
    const current = snapshot();
    current.operational.reconciliation = {
      state: "succeeded",
      generation: 1,
      lastStartedAt: "2026-07-21T12:00:08Z",
      lastSucceededAt: "2026-07-21T12:00:09Z",
      lastError: null,
    };
    const result = evaluateSnapshotDataQuality(
      current,
      settings,
      new Date("2026-07-21T12:00:10Z"),
    );
    assert.equal(result.stateAgeMs, 6_000);
    assert.ok(!result.issues.includes("account_state_stale"));
  });

  it("still marks account state stale when reconciliation runs too long", () => {
    const current = snapshot();
    current.operational.reconciliation = {
      state: "running",
      generation: 1,
      lastStartedAt: "2026-07-21T11:59:00Z",
      lastSucceededAt: "2026-07-21T11:59:04Z",
      lastError: null,
    };
    const result = evaluateSnapshotDataQuality(
      current,
      settings,
      new Date("2026-07-21T12:00:10Z"),
    );
    assert.ok(result.issues.includes("account_state_stale"));
  });

  it("rejects invalid and materially future timestamps explicitly", () => {
    const invalid = snapshot();
    invalid.capturedAt = "not-a-date";
    invalid.quote = { ...invalid.quote!, timestamp: "not-a-date" };
    const invalidResult = evaluateSnapshotDataQuality(
      invalid,
      settings,
      new Date("2026-07-21T12:00:05Z"),
    );
    assert.ok(invalidResult.issues.includes("quote_timestamp_invalid"));
    assert.ok(invalidResult.issues.includes("account_state_timestamp_invalid"));

    const future = snapshot();
    future.capturedAt = "2026-07-21T12:00:12Z";
    future.quote = { ...future.quote!, timestamp: "2026-07-21T12:00:12Z" };
    const futureResult = evaluateSnapshotDataQuality(
      future,
      settings,
      new Date("2026-07-21T12:00:05Z"),
    );
    assert.ok(futureResult.issues.includes("quote_timestamp_future"));
    assert.ok(futureResult.issues.includes("account_state_timestamp_future"));
  });

  it("treats quote clock skew up to 5s as fresh with no advisory", () => {
    const skewed = snapshot();
    skewed.quote = { ...skewed.quote!, timestamp: "2026-07-21T12:00:09.500Z" };
    const result = evaluateSnapshotDataQuality(
      skewed,
      settings,
      new Date("2026-07-21T12:00:05Z"),
    );
    assert.equal(result.quoteAgeMs, 0);
    assert.equal(result.stateComplete, true);
    assert.equal(result.issues.length, 0);
  });

  it("reports locked BBO (bid==ask) as quote_locked with distinct axes", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 20000, bestAsk: 20000, lastPrice: 20000 };
    const result = evaluateSnapshotDataQuality(locked, settings, new Date("2026-07-21T12:00:05Z"), {
      quoteSource: "projectx_quote_stream",
      observationSucceededUtc: "2026-07-21T12:00:04Z",
    });
    assert.ok(result.issues.includes("quote_locked"));
    assert.ok(!result.issues.includes("quote_geometry_invalid"));
    assert.equal(result.quoteState, "locked");
    assert.equal(result.dataCompleteness, true);
    assert.equal(result.executionEligibility, "blocked_locked");
    assert.equal(result.stateComplete, false);
    assert.deepEqual(result.quoteGeometryTelemetry?.reason_codes, ["locked_bbo"]);
    assert.equal(result.quoteGeometryTelemetry?.quote_source, "projectx_quote_stream");
    assert.equal(result.quoteGeometryTelemetry?.reconnect_generation, 1);
    assert.equal(result.quoteGeometryTelemetry?.last, 20000);
  });

  it("reports crossed BBO as quote_geometry_invalid with execution blocked_invalid", () => {
    const crossed = snapshot();
    crossed.quote = {
      ...crossed.quote!,
      bestBid: 29500,
      bestAsk: 29419.5,
    };
    const result = evaluateSnapshotDataQuality(
      crossed,
      settings,
      new Date("2026-07-21T12:00:05Z"),
    );
    assert.ok(result.issues.includes("quote_geometry_invalid"));
    assert.equal(result.quoteState, "invalid");
    assert.equal(result.executionEligibility, "blocked_invalid");
    assert.equal(result.stateComplete, false);
    assert.ok(result.quoteGeometryTelemetry);
    assert.equal(result.quoteGeometryTelemetry!.best_bid, 29500);
    assert.equal(result.quoteGeometryTelemetry!.best_ask, 29419.5);
    assert.ok(result.quoteGeometryTelemetry!.reason_codes.includes("crossed_bbo"));
  });

  it("reports one-sided nonpositive ask as quote_geometry_invalid", () => {
    const oneSided = snapshot();
    oneSided.quote = { ...oneSided.quote!, bestBid: 20000, bestAsk: 0 };
    const result = evaluateSnapshotDataQuality(oneSided, settings, new Date("2026-07-21T12:00:05Z"));
    assert.ok(result.issues.includes("quote_geometry_invalid"));
    assert.equal(result.stateComplete, false);
    assert.ok(result.quoteGeometryTelemetry?.reason_codes.includes("nonpositive_bbo"));
  });

  it("reports nonfinite BBO as quote_geometry_invalid", () => {
    const bad = snapshot();
    bad.quote = { ...bad.quote!, bestBid: Number.NaN, bestAsk: 20000 };
    const result = evaluateSnapshotDataQuality(bad, settings, new Date("2026-07-21T12:00:05Z"));
    assert.ok(result.issues.includes("quote_geometry_invalid"));
    assert.equal(result.stateComplete, false);
    assert.equal(result.quoteGeometryTelemetry?.best_bid, null);
    assert.ok(result.quoteGeometryTelemetry?.reason_codes.includes("nonfinite_bbo"));
  });

  it("recovers to state_complete when geometry becomes valid again", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20000, bestAsk: 20000 };
    const bad = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(bad.stateComplete, false);
    current.quote = { ...current.quote!, bestBid: 19999.75, bestAsk: 20000.25 };
    const ok = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(ok.stateComplete, true);
    assert.equal(ok.quoteGeometryTelemetry, null);
    assert.deepEqual(ok.issues, []);
  });

  it("retains the last invalid quote telemetry across a healthy follow-up poll", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20000, bestAsk: 20000, lastPrice: 20000 };
    evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"), {
      quoteSource: "projectx_quote_stream",
      observationSucceededUtc: "2026-07-21T12:00:04Z",
    });

    current.quote = { ...current.quote!, bestBid: 19999.75, bestAsk: 20000.25, lastPrice: 20000 };
    const healthy = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:06Z"));
    const fields = dataQualityHealthFields(healthy, new Date("2026-07-21T12:00:06Z")) as {
      quote_geometry_last_invalid?: {
        telemetry: { reason_codes: string[]; quote_source: string };
        firstObservedAtUtc: string;
        observedAtUtc: string;
        expiresAtUtc: string;
        observationCount: number;
      };
    };

    assert.equal(healthy.stateComplete, true);
    assert.equal(healthy.quoteGeometryTelemetry, null);
    assert.deepEqual(fields.quote_geometry_last_invalid?.telemetry.reason_codes, ["locked_bbo"]);
    assert.equal(fields.quote_geometry_last_invalid?.telemetry.quote_source, "projectx_quote_stream");
    assert.equal(fields.quote_geometry_last_invalid?.firstObservedAtUtc, "2026-07-21T12:00:05.000Z");
    assert.equal(fields.quote_geometry_last_invalid?.observedAtUtc, "2026-07-21T12:00:05.000Z");
    assert.equal(fields.quote_geometry_last_invalid?.expiresAtUtc, "2026-07-21T12:02:05.000Z");
    assert.equal(fields.quote_geometry_last_invalid?.observationCount, 1);
  });

  it("accumulates observationCount for the same locked BBO episode", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20000, bestAsk: 20000, lastPrice: 20000 };
    evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"), {
      quoteSource: "venue_snapshot_quote",
    });
    evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:20Z"), {
      quoteSource: "venue_snapshot_quote",
    });
    const stillInvalid = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:35Z"), {
      quoteSource: "venue_snapshot_quote",
    });
    const fields = dataQualityHealthFields(stillInvalid, new Date("2026-07-21T12:00:35Z")) as {
      quote_geometry_last_invalid?: {
        firstObservedAtUtc: string;
        observedAtUtc: string;
        observationCount: number;
      };
    };
    assert.equal(fields.quote_geometry_last_invalid?.firstObservedAtUtc, "2026-07-21T12:00:05.000Z");
    assert.equal(fields.quote_geometry_last_invalid?.observedAtUtc, "2026-07-21T12:00:35.000Z");
    assert.equal(fields.quote_geometry_last_invalid?.observationCount, 3);
  });

  it("expires retained telemetry after the bounded ttl and cleans it up", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20000, bestAsk: 20000 };
    evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));

    current.quote = { ...current.quote!, bestBid: 19999.75, bestAsk: 20000.25 };
    const healthy = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:02:06Z"));
    const expiredFields = dataQualityHealthFields(healthy, new Date("2026-07-21T12:02:06Z")) as {
      quote_geometry_last_invalid?: unknown;
    };
    assert.equal(expiredFields.quote_geometry_last_invalid, undefined);

    const cleanedFields = dataQualityHealthFields(healthy, new Date("2026-07-21T12:02:07Z")) as {
      quote_geometry_last_invalid?: unknown;
    };
    assert.equal(cleanedFields.quote_geometry_last_invalid, undefined);
  });

  it("replaces the retained telemetry with the newest invalid quote", () => {
    const current = snapshot();
    current.quote = { ...current.quote!, bestBid: 20000, bestAsk: 20000, lastPrice: 20000 };
    evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));

    current.quote = { ...current.quote!, bestBid: 20001, bestAsk: 0, lastPrice: 20001 };
    evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:10Z"));

    current.quote = { ...current.quote!, bestBid: 19999.75, bestAsk: 20000.25, lastPrice: 20000 };
    const healthy = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:11Z"));
    const fields = dataQualityHealthFields(healthy, new Date("2026-07-21T12:00:11Z")) as {
      quote_geometry_last_invalid?: {
        telemetry: { best_ask: number | null; reason_codes: string[] };
        observedAtUtc: string;
      };
    };

    assert.equal(fields.quote_geometry_last_invalid?.telemetry.best_ask, 0);
    assert.ok(fields.quote_geometry_last_invalid?.telemetry.reason_codes.includes("nonpositive_bbo"));
    assert.equal(fields.quote_geometry_last_invalid?.observedAtUtc, "2026-07-21T12:00:10.000Z");
  });
});

