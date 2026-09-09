import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSnapshotDataQuality, newExposureBlockCode } from "../src/state/data-quality.js";
import { actionAllowedForQuote } from "../src/state/quote-state.js";
import type { RiskSettings } from "../src/domain/models.js";
import { snapshot } from "./fixtures.js";

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

describe("newExposureBlockCode zero-write gate", () => {
  it("blocks new exposure for locked quotes; risk reduction remains eligible", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 29456, bestAsk: 29456 };
    const quality = evaluateSnapshotDataQuality(locked, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(newExposureBlockCode(quality), "quote_locked");
    assert.equal(quality.riskReductionEligibility, "eligible");
    assert.equal(actionAllowedForQuote("exit_reduction", quality.executionEligibility), true);
    assert.equal(actionAllowedForQuote("protective_action", quality.executionEligibility), true);
  });

  it("blocks new exposure for invalid quotes; flatten/recovery stay allowed", () => {
    const crossed = snapshot();
    crossed.quote = { ...crossed.quote!, bestBid: 29500, bestAsk: 29400 };
    const quality = evaluateSnapshotDataQuality(crossed, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(newExposureBlockCode(quality), "quote_geometry_invalid");
    assert.equal(actionAllowedForQuote("flatten", quality.executionEligibility), true);
    assert.equal(actionAllowedForQuote("recovery", quality.executionEligibility), true);
  });

  it("allows new exposure only for normal eligible quotes", () => {
    const quality = evaluateSnapshotDataQuality(snapshot(), settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(quality.quoteState, "normal");
    assert.equal(newExposureBlockCode(quality), null);
  });
});
