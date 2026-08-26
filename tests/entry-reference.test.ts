import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QuoteInfo } from "../src/domain/models.js";
import {
  buildEntryBandGuidance,
  computeSpreadTicks,
  isExecutableQuoteGeometry,
  resolveDecisionReferencePrice,
  resolveExecutableReferencePrice,
} from "../src/domain/entry-reference.js";

function quote(partial: Partial<QuoteInfo> & Pick<QuoteInfo, "lastPrice" | "bestBid" | "bestAsk">): QuoteInfo {
  return {
    contractId: "CON.TEST",
    symbol: "TEST",
    open: partial.lastPrice,
    high: partial.lastPrice,
    low: partial.lastPrice,
    volume: 1,
    timestamp: "2099-01-01T00:00:00Z",
    ...partial,
  };
}

describe("entry-reference", () => {
  it("prefers last for decision reference", () => {
    const price = resolveDecisionReferencePrice(quote({
      lastPrice: 21000,
      bestBid: 20999.5,
      bestAsk: 21000.5,
    }));
    assert.equal(price, 21000);
  });

  it("falls back to mid when last missing", () => {
    const price = resolveDecisionReferencePrice(quote({
      lastPrice: 0,
      bestBid: 100,
      bestAsk: 102,
    }));
    assert.equal(price, 101);
  });

  it("uses ask for long executable reference", () => {
    const price = resolveExecutableReferencePrice("long", quote({
      lastPrice: 21000,
      bestBid: 20999.5,
      bestAsk: 21000.5,
    }));
    assert.equal(price, 21000.5);
  });

  it("builds advisory entry band guidance from spread", () => {
    const guidance = buildEntryBandGuidance(1);
    assert.equal(guidance.schema_version, "glitch.topstep.entry_band_guidance.v1");
    assert.equal(guidance.suggested_min_width_ticks, 3);
    assert.equal(guidance.spread_ticks, 1);
    assert.ok(guidance.notes.length >= 1);
  });

  it("returns unusable guidance for invalid spread", () => {
    const guidance = buildEntryBandGuidance(-322);
    assert.equal(guidance.suggested_min_width_ticks, null);
    assert.equal(guidance.spread_ticks, null);
    assert.match(guidance.notes[0] ?? "", /Unusable/);
  });

  it("does not mid from crossed BBO for decision reference without last", () => {
    const price = resolveDecisionReferencePrice(quote({
      lastPrice: 0,
      bestBid: 29500,
      bestAsk: 29419.5,
    }));
    assert.equal(price, 29419.5);
  });

  it("computeSpreadTicks returns null for crossed BBO", () => {
    assert.equal(computeSpreadTicks(29500, 29419.5, 0.25), null);
    assert.equal(isExecutableQuoteGeometry(29500, 29419.5), false);
  });
});
