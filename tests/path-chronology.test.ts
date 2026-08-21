import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPathChronologyFromExcursion } from "../src/learning/path-chronology.js";
import { PATH_CHRONOLOGY_SCHEMA } from "../src/learning/trade-outcome.js";

describe("buildPathChronologyFromExcursion", () => {
  it("returns null when both excursion magnitudes are missing", () => {
    assert.equal(buildPathChronologyFromExcursion({ mfe_usd: null, mae_usd: null }), null);
  });

  it("marks partial evidence when only USD magnitudes are known", () => {
    const chronology = buildPathChronologyFromExcursion({
      mfe_usd: 50,
      mae_usd: 8,
      mfe_ticks: 100,
      mae_ticks: 16,
    });
    assert.ok(chronology);
    assert.equal(chronology?.schema_version, PATH_CHRONOLOGY_SCHEMA);
    assert.equal(chronology?.evidence_quality, "partial");
    assert.equal(chronology?.mfe.usd, 50);
    assert.equal(chronology?.mfe.price, null);
    assert.equal(chronology?.mfe.utc, null);
    assert.equal(chronology?.mfe.ticks, 100);
    assert.equal(chronology?.mae.usd, 8);
    assert.equal(chronology?.mae.ticks, 16);
  });

  it("marks complete evidence when price and utc are present for both extremes", () => {
    const chronology = buildPathChronologyFromExcursion({
      mfe_usd: 50,
      mae_usd: 8,
      mfe_price: 28620,
      mfe_utc: "2026-08-03T13:58:00.000Z",
      mae_price: 28570,
      mae_utc: "2026-08-03T13:57:30.000Z",
      mfe_ticks: 100,
      mae_ticks: 16,
    });
    assert.equal(chronology?.evidence_quality, "complete");
    assert.equal(chronology?.mfe.price, 28620);
    assert.equal(chronology?.mae.utc, "2026-08-03T13:57:30.000Z");
  });

  it("marks same_event_gap when flagged", () => {
    const chronology = buildPathChronologyFromExcursion({
      mfe_usd: 10,
      mae_usd: 5,
      same_event_gap: true,
    });
    assert.equal(chronology?.evidence_quality, "same_event_gap");
  });
});
