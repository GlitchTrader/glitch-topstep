import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RiskSettings } from "../src/domain/models.js";
import { evaluateSnapshotDataQuality } from "../src/state/data-quality.js";
import { snapshot } from "./fixtures.js";

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

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

  it("reports crossed BBO as quote_geometry_invalid", () => {
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
    assert.equal(result.stateComplete, false);
    assert.ok(result.quoteGeometryTelemetry);
    assert.equal(result.quoteGeometryTelemetry!.best_bid, 29500);
    assert.equal(result.quoteGeometryTelemetry!.best_ask, 29419.5);
    assert.ok(result.quoteGeometryTelemetry!.reason_codes.includes("crossed_bbo"));
  });

  it("reports locked BBO (bid==ask) as quote_geometry_invalid with telemetry", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 20000, bestAsk: 20000, lastPrice: 20000 };
    const result = evaluateSnapshotDataQuality(locked, settings, new Date("2026-07-21T12:00:05Z"), {
      quoteSource: "projectx_quote_stream",
      observationSucceededUtc: "2026-07-21T12:00:04Z",
    });
    assert.ok(result.issues.includes("quote_geometry_invalid"));
    assert.equal(result.stateComplete, false);
    assert.deepEqual(result.quoteGeometryTelemetry?.reason_codes, ["locked_bbo"]);
    assert.equal(result.quoteGeometryTelemetry?.quote_source, "projectx_quote_stream");
    assert.equal(result.quoteGeometryTelemetry?.reconnect_generation, 1);
    assert.equal(result.quoteGeometryTelemetry?.last, 20000);
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
});

