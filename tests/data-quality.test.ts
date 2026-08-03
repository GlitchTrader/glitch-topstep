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
    const result = evaluateSnapshotDataQuality(
      snapshot(),
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
    future.capturedAt = "2026-07-21T12:00:08Z";
    future.quote = { ...future.quote!, timestamp: "2026-07-21T12:00:08Z" };
    const futureResult = evaluateSnapshotDataQuality(
      future,
      settings,
      new Date("2026-07-21T12:00:05Z"),
    );
    assert.ok(futureResult.issues.includes("quote_timestamp_future"));
    assert.ok(futureResult.issues.includes("account_state_timestamp_future"));
  });
});
