import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessBbo,
  assessOpenOrders,
  evaluateControlledValidationGates,
  normalizeExplicitArray,
} from "../src/ops/controlled-validation-gates.js";

describe("normalizeExplicitArray", () => {
  it("treats null as absent/ambiguous with zero items (never Count=1)", () => {
    const result = normalizeExplicitArray(null);
    assert.equal(result.present, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.items.length, 0);
  });

  it("treats undefined as absent/ambiguous", () => {
    const result = normalizeExplicitArray(undefined);
    assert.equal(result.present, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.items.length, 0);
  });

  it("accepts an empty array as present", () => {
    const result = normalizeExplicitArray([]);
    assert.equal(result.present, true);
    assert.equal(result.ambiguous, false);
    assert.equal(result.items.length, 0);
  });
});

describe("assessOpenOrders", () => {
  it("fail-closes when orders=null and openOrders is missing (PowerShell phantom)", () => {
    const result = assessOpenOrders({ orders: null });
    assert.equal(result.confirmed_empty, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.count, null);
    assert.equal(result.reason, "openOrders_missing_or_not_array");
  });

  it("confirms empty only for explicit openOrders=[]", () => {
    const result = assessOpenOrders({ openOrders: [] });
    assert.equal(result.confirmed_empty, true);
    assert.equal(result.ambiguous, false);
    assert.equal(result.count, 0);
    assert.equal(result.reason, "openOrders_empty");
  });

  it("reports a real working order without ambiguity", () => {
    const result = assessOpenOrders({
      openOrders: [
        {
          id: 42,
          status: 1,
          size: 1,
          contractId: "CON.F.US.MNQ.Z26",
        },
      ],
    });
    assert.equal(result.confirmed_empty, false);
    assert.equal(result.ambiguous, false);
    assert.equal(result.count, 1);
    assert.equal(result.working_orders[0]?.id, 42);
  });

  it("does not treat missing openOrders as empty even if positions are flat", () => {
    const result = assessOpenOrders({ positions: [] });
    assert.equal(result.confirmed_empty, false);
    assert.equal(result.ambiguous, true);
  });
});

describe("assessBbo", () => {
  const now = Date.parse("2026-09-22T16:54:00.000Z");

  it("accepts BBO from state.quote.bestBid/bestAsk", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      {},
      { now_ms: now, max_age_ms: 6_000 },
    );
    assert.equal(result.complete, true);
    assert.equal(result.stale, false);
    assert.equal(result.source, "state.quote");
    assert.equal(result.bid, 30943);
    assert.equal(result.ask, 30943.5);
  });

  it("accepts BBO from packet.market.bid/ask when state quote is missing", () => {
    const result = assessBbo(
      {},
      {
        market: {
          bid: 30943.25,
          ask: 30943.75,
          quote_timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      { now_ms: now, max_age_ms: 6_000 },
    );
    assert.equal(result.complete, true);
    assert.equal(result.source, "packet.market");
    assert.equal(result.bid, 30943.25);
    assert.equal(result.ask, 30943.75);
  });

  it("does not accept legacy best_bid/best_ask as an official path", () => {
    const result = assessBbo(
      {},
      {
        market: {
          best_bid: 30943,
          best_ask: 30943.5,
          quote_timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      { now_ms: now },
    );
    assert.equal(result.complete, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.reason, "bbo_missing_on_official_paths");
  });

  it("marks present BBO stale when timestamp is too old", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:00.000Z",
        },
      },
      {},
      { now_ms: now, max_age_ms: 6_000 },
    );
    assert.equal(result.complete, false);
    assert.equal(result.stale, true);
    assert.match(result.reason, /stale/);
  });

  it("marks BBO incomplete when health reports quote_stale", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      {},
      {
        now_ms: now,
        max_age_ms: 6_000,
        health: { data_quality: { issues: ["quote_stale"] } },
      },
    );
    assert.equal(result.complete, false);
    assert.equal(result.stale, true);
  });

  it("fail-closes when BBO is absent", () => {
    const result = assessBbo({ quote: {} }, { market: {} }, { now_ms: now });
    assert.equal(result.complete, false);
    assert.equal(result.ambiguous, true);
  });
});

describe("evaluateControlledValidationGates", () => {
  const now = Date.parse("2026-09-22T16:54:00.000Z");

  function baseReady() {
    return {
      now_ms: now,
      packet_latency_ms: 1_000,
      health: {
        status: "ok",
        trading_mode: "shadow",
        delivery_effective: "disabled",
        protected_reduction: { unprotected_open_quantity: 0 },
        read_circuit_breaker: {
          positions: { open: false },
          orders: { open: false },
        },
        data_quality: {
          state_complete: true,
          issues: [],
          operational: {
            userStream: {
              state: "connected",
              lastEventAt: "2026-09-22T16:53:50.000Z",
            },
            marketStream: {
              state: "connected",
              lastEventAt: "2026-09-22T16:53:55.000Z",
            },
            reconciliation: {
              state: "succeeded",
              lastSucceededAt: "2026-09-22T16:53:40.000Z",
            },
          },
        },
      },
      state: {
        positions: [],
        openOrders: [],
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      packet: {
        market: {
          bid: 30943.25,
          ask: 30943.75,
          quote_timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
    };
  }

  it("passes a fully ready shadow snapshot", () => {
    const result = evaluateControlledValidationGates(baseReady());
    assert.equal(result.all_passed, true);
    assert.deepEqual(result.failed_gates, []);
    assert.equal(result.open_orders.confirmed_empty, true);
    assert.equal(result.bbo.complete, true);
  });

  it("fail-closes on orders=null phantom without openOrders", () => {
    const input = baseReady();
    const result = evaluateControlledValidationGates({
      ...input,
      state: {
        positions: [],
        orders: null,
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
    });
    assert.equal(result.gates.open_orders_confirmed_empty, false);
    assert.ok(result.failed_gates.includes("open_orders_confirmed_empty"));
  });

  it("does not relax user.lastEventAt=null for flat accounts", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: { operational: { userStream: { lastEventAt: string | null } } };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    const result = evaluateControlledValidationGates({
      ...input,
      health,
    });
    assert.equal(result.gates.user_stream_recent_events, false);
    assert.ok(result.failed_gates.includes("user_stream_recent_events"));
    assert.ok(result.notes.some((note) => note.includes("flat-idle")));
  });
});
