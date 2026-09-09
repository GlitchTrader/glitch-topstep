import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSnapshotDataQuality, mutationBlockCode } from "../src/state/data-quality.js";
import type { RiskSettings } from "../src/domain/models.js";
import { snapshot } from "./fixtures.js";

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

describe("mutationBlockCode zero-write gate", () => {
  it("blocks place/modify/close for locked quotes", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 29456, bestAsk: 29456 };
    const quality = evaluateSnapshotDataQuality(locked, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(mutationBlockCode(quality), "quote_locked");
  });

  it("blocks place/modify/close for invalid quotes", () => {
    const crossed = snapshot();
    crossed.quote = { ...crossed.quote!, bestBid: 29500, bestAsk: 29400 };
    const quality = evaluateSnapshotDataQuality(crossed, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(mutationBlockCode(quality), "quote_geometry_invalid");
  });

  it("allows mutations only for normal eligible quotes", () => {
    const quality = evaluateSnapshotDataQuality(snapshot(), settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(quality.quoteState, "normal");
    assert.equal(mutationBlockCode(quality), null);
  });
});
