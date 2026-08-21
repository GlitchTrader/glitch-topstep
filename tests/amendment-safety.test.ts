import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProtectiveAmendment, buildOriginalRiskEnvelope } from "../src/execution/amendment-safety.js";

const quote = { bestBid: 19_999.75, bestAsk: 20_000.25 };

describe("amendment safety", () => {
  it("allows long stop tighten and rejects widen", () => {
    const base = {
      side: "long" as const,
      leg: "stop" as const,
      currentPrice: 19_990,
      averageEntry: 20_000,
      ...quote,
    };
    assert.deepEqual(
      validateProtectiveAmendment({ ...base, newPrice: 20_000 }),
      { ok: true, amendment_source: "HERMES_INTENT" },
    );
    assert.deepEqual(
      validateProtectiveAmendment({ ...base, newPrice: 19_980 }),
      { ok: false, code: "stop_would_widen" },
    );
  });

  it("allows short stop tighten and rejects widen", () => {
    const base = {
      side: "short" as const,
      leg: "stop" as const,
      currentPrice: 20_010,
      averageEntry: 20_000,
      ...quote,
    };
    assert.deepEqual(
      validateProtectiveAmendment({ ...base, newPrice: 20_005 }),
      { ok: true, amendment_source: "HERMES_INTENT" },
    );
    assert.deepEqual(
      validateProtectiveAmendment({ ...base, newPrice: 20_015 }),
      { ok: false, code: "stop_would_widen" },
    );
  });

  it("rejects marketable-side stops", () => {
    assert.deepEqual(
      validateProtectiveAmendment({
        side: "long",
        leg: "stop",
        currentPrice: 19_990,
        newPrice: 20_000.25,
        averageEntry: 20_000,
        ...quote,
      }),
      { ok: false, code: "stop_wrong_side_of_market" },
    );
    assert.deepEqual(
      validateProtectiveAmendment({
        side: "short",
        leg: "stop",
        currentPrice: 20_010,
        newPrice: 19_999.75,
        averageEntry: 20_000,
        ...quote,
      }),
      { ok: false, code: "stop_wrong_side_of_market" },
    );
  });

  it("allows long target extension and rejects worsen or wrong side of entry", () => {
    const base = {
      side: "long" as const,
      leg: "target" as const,
      currentPrice: 20_020,
      averageEntry: 20_000,
      ...quote,
    };
    assert.deepEqual(
      validateProtectiveAmendment({ ...base, newPrice: 20_030 }),
      { ok: true, amendment_source: "HERMES_INTENT" },
    );
    assert.deepEqual(
      validateProtectiveAmendment({ ...base, newPrice: 20_010 }),
      { ok: false, code: "target_would_widen" },
    );
    assert.deepEqual(
      validateProtectiveAmendment({
        ...base,
        currentPrice: 20_020,
        averageEntry: 20_025,
        newPrice: 20_022,
      }),
      { ok: false, code: "target_wrong_side_of_entry" },
    );
  });

  it("rejects missing protective reference prices", () => {
    assert.deepEqual(
      validateProtectiveAmendment({
        side: "long",
        leg: "stop",
        currentPrice: null,
        newPrice: 20_000,
        averageEntry: 20_000,
        ...quote,
      }),
      { ok: false, code: "amendment_current_price_missing" },
    );
  });

  it("TS-AUTH-02 auto breakeven rejects widen", () => {
    assert.deepEqual(
      validateProtectiveAmendment({
        side: "long",
        leg: "stop",
        currentPrice: 20_000,
        newPrice: 19_990,
        averageEntry: 20_000,
        source: "AUTO_BREAKEVEN",
        ...quote,
      }),
      { ok: false, code: "stop_would_widen" },
    );
  });

  it("TS-AUTH-02 Hermes widen succeeds inside original envelope", () => {
    const envelope = buildOriginalRiskEnvelope({
      intentId: "intent-1",
      side: "long",
      averageEntry: 20_000,
      stopLoss: 19_980,
      tickSize: 0.25,
      scopeIdentity: "acct:contract",
    });
    assert.deepEqual(
      validateProtectiveAmendment({
        side: "long",
        leg: "stop",
        currentPrice: 19_990,
        newPrice: 19_985,
        averageEntry: 20_000,
        source: "HERMES_INTENT",
        tickSize: 0.25,
        originalRiskEnvelope: envelope,
        ...quote,
      }),
      { ok: true, amendment_source: "HERMES_INTENT" },
    );
  });

  it("TS-AUTH-02 Hermes widen beyond envelope is rejected", () => {
    const envelope = buildOriginalRiskEnvelope({
      intentId: "intent-1",
      side: "long",
      averageEntry: 20_000,
      stopLoss: 19_980,
      tickSize: 0.25,
      scopeIdentity: "acct:contract",
    });
    assert.deepEqual(
      validateProtectiveAmendment({
        side: "long",
        leg: "stop",
        currentPrice: 19_990,
        newPrice: 19_970,
        averageEntry: 20_000,
        source: "HERMES_INTENT",
        tickSize: 0.25,
        originalRiskEnvelope: envelope,
        ...quote,
      }),
      { ok: false, code: "stop_widen_exceeds_risk_envelope" },
    );
  });
});
