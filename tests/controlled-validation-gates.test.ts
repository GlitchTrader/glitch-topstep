import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessBbo,
  assessFlatIdleUserStream,
  assessOpenOrders,
  evaluateControlledValidationGates,
  normalizeExplicitArray,
  reconciliationFresh,
  resolveCaptureClock,
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

describe("resolveCaptureClock", () => {
  it("prefers capture_now_ms then health.recorded_utc", () => {
    assert.equal(
      resolveCaptureClock(
        { recorded_utc: "2026-09-22T16:54:00.000Z" },
        { capturedAt: "2026-09-22T16:53:00.000Z" },
        { capture_now_ms: 1000 },
      )?.source,
      "capture_now_ms",
    );
    assert.equal(
      resolveCaptureClock(
        { recorded_utc: "2026-09-22T16:54:00.000Z" },
        { capturedAt: "2026-09-22T16:53:00.000Z" },
        {},
      )?.source,
      "health.recorded_utc",
    );
  });

  it("returns null when no capture clock is available (no Date.now fallback)", () => {
    assert.equal(resolveCaptureClock({}, {}, {}), null);
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
  const captureNow = Date.parse("2026-09-22T16:54:00.000Z");

  it("accepts BBO from state.quote.bestBid/bestAsk via capture clock", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      {},
      { capture_now_ms: captureNow, max_age_ms: 6_000 },
    );
    assert.equal(result.complete, true);
    assert.equal(result.stale, false);
    assert.equal(result.source, "state.quote");
    assert.equal(result.age_source, "timestamp_vs_capture");
    assert.equal(result.bid, 30943);
    assert.equal(result.ask, 30943.5);
  });

  it("prefers health.quote_age_ms over timestamp math", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          // Deliberately old timestamp — must be ignored when quote_age_ms is present.
          timestamp: "2026-09-22T16:00:00.000Z",
        },
      },
      {},
      {
        capture_now_ms: captureNow,
        max_age_ms: 6_000,
        health: { data_quality: { quote_age_ms: 44, issues: [] } },
      },
    );
    assert.equal(result.complete, true);
    assert.equal(result.stale, false);
    assert.equal(result.age_ms, 44);
    assert.equal(result.age_source, "quote_age_ms");
  });

  it("does not use wall-clock: missing capture clock without quote_age_ms fails closed", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      {},
      { capture_now_ms: null, max_age_ms: 6_000 },
    );
    assert.equal(result.complete, false);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "bbo_capture_age_unavailable");
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
      { capture_now_ms: captureNow, max_age_ms: 6_000 },
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
      { capture_now_ms: captureNow },
    );
    assert.equal(result.complete, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.reason, "bbo_missing_on_official_paths");
  });

  it("marks present BBO stale when timestamp is too old vs capture", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943.5,
          timestamp: "2026-09-22T16:53:00.000Z",
        },
      },
      {},
      { capture_now_ms: captureNow, max_age_ms: 6_000 },
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
        capture_now_ms: captureNow,
        max_age_ms: 6_000,
        health: { data_quality: { issues: ["quote_stale"], quote_age_ms: 100 } },
      },
    );
    assert.equal(result.complete, false);
    assert.equal(result.stale, true);
  });

  it("fail-closes locked BBO through classifyQuoteState (not ask>bid)", () => {
    const result = assessBbo(
      {
        quote: {
          bestBid: 30943,
          bestAsk: 30943,
          timestamp: "2026-09-22T16:53:58.000Z",
        },
      },
      {},
      { capture_now_ms: captureNow, max_age_ms: 6_000 },
    );
    assert.equal(result.complete, false);
    assert.equal(result.ambiguous, true);
    assert.equal(result.reason, "bbo_geometry_invalid");
  });

  it("fail-closes when BBO is absent", () => {
    const result = assessBbo({ quote: {} }, { market: {} }, { capture_now_ms: captureNow });
    assert.equal(result.complete, false);
    assert.equal(result.ambiguous, true);
  });
});

describe("evaluateControlledValidationGates", () => {
  const now = Date.parse("2026-09-22T16:54:00.000Z");

  function baseReady() {
    return {
      capture_now_ms: now,
      packet_latency_ms: 1_000,
      health: {
        status: "ok",
        trading_mode: "shadow",
        delivery_effective: "disabled",
        recorded_utc: "2026-09-22T16:54:00.000Z",
        protected_reduction: { unprotected_open_quantity: 0 },
        read_circuit_breaker: {
          positions: { open: false },
          orders: { open: false },
        },
        data_quality: {
          state_complete: true,
          issues: [],
          quote_age_ms: 44,
          operational: {
            generation: 1,
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
              generation: 1,
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
    assert.equal(result.user_stream_mode, "recent_events");
    assert.equal(result.schema_version, "glitch.topstep.controlled_validation_gates.v2");
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

  it("allows flat_idle_user_stream when all preconditions hold", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: {
        operational: {
          userStream: { lastEventAt: string | null };
        };
      };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    const result = evaluateControlledValidationGates({
      ...input,
      health,
    });
    assert.equal(result.user_stream_mode, "flat_idle_user_stream");
    assert.equal(result.flat_idle_user_stream.eligible, true);
    assert.equal(result.gates.user_stream_recent_events, true);
    assert.equal(result.all_passed, true);
  });

  it("still fails flat-idle when a position is open", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: {
        operational: {
          userStream: { lastEventAt: string | null };
        };
      };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    const result = evaluateControlledValidationGates({
      ...input,
      health,
      state: {
        ...input.state,
        positions: [{ id: 1, size: 1, contractId: "CON.F.US.MNQ.Z26" }],
      },
    });
    assert.equal(result.user_stream_mode, "insufficient");
    assert.equal(result.flat_idle_user_stream.eligible, false);
    assert.ok(result.failed_gates.includes("user_stream_recent_events"));
    assert.ok(result.failed_gates.includes("account_flat"));
  });

  it("still fails flat-idle when openOrders is non-empty", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: {
        operational: {
          userStream: { lastEventAt: string | null };
        };
      };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    const result = evaluateControlledValidationGates({
      ...input,
      health,
      state: {
        ...input.state,
        openOrders: [{ id: 9, status: 1, size: 1 }],
      },
    });
    assert.equal(result.user_stream_mode, "insufficient");
    assert.equal(result.flat_idle_user_stream.reason, "open_orders_not_confirmed_empty");
    assert.ok(result.failed_gates.includes("user_stream_recent_events"));
  });

  it("still fails flat-idle when reconciliation is running (pending recovery)", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: {
        issues: string[];
        operational: {
          userStream: { lastEventAt: string | null };
          reconciliation: { state: string };
        };
      };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    health.data_quality.operational.reconciliation.state = "running";
    health.data_quality.issues = ["reconciliation_not_current"];
    const result = evaluateControlledValidationGates({
      ...input,
      health,
    });
    assert.equal(result.user_stream_mode, "insufficient");
    assert.match(result.flat_idle_user_stream.reason, /reconciliation/);
    assert.ok(result.failed_gates.includes("user_stream_recent_events"));
    assert.ok(result.failed_gates.includes("reconciliation_ok"));
  });

  it("still fails flat-idle when market events are not recent", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: {
        operational: {
          userStream: { lastEventAt: string | null };
          marketStream: { lastEventAt: string };
        };
      };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    health.data_quality.operational.marketStream.lastEventAt = "2026-09-22T16:50:00.000Z";
    const result = evaluateControlledValidationGates({
      ...input,
      health,
    });
    assert.equal(result.user_stream_mode, "insufficient");
    assert.equal(result.flat_idle_user_stream.reason, "market_stream_events_not_recent");
    assert.ok(result.failed_gates.includes("user_stream_recent_events"));
    assert.ok(result.failed_gates.includes("market_stream_recent_events"));
  });

  it("evaluates BBO from frozen health.quote_age_ms without wall-clock", () => {
    const input = baseReady();
    // Omit capture_now_ms; clock comes from health.recorded_utc. quote_age_ms=44 wins.
    const { capture_now_ms: _drop, ...rest } = input;
    const result = evaluateControlledValidationGates(rest);
    assert.equal(result.capture_clock?.source, "health.recorded_utc");
    assert.equal(result.bbo.age_source, "quote_age_ms");
    assert.equal(result.bbo.complete, true);
    assert.equal(result.gates.bbo_complete, true);
  });

  it("keeps flat_idle insufficient when BBO is absent (never approves)", () => {
    const input = baseReady();
    const health = structuredClone(input.health) as {
      data_quality: {
        quote_age_ms?: number;
        operational: {
          userStream: { lastEventAt: string | null };
        };
      };
    };
    health.data_quality.operational.userStream.lastEventAt = null;
    delete health.data_quality.quote_age_ms;
    const result = evaluateControlledValidationGates({
      ...input,
      health,
      state: {
        positions: [],
        openOrders: [],
        quote: {},
      },
      packet: { market: {} },
    });
    assert.equal(result.user_stream_mode, "insufficient");
    assert.equal(result.flat_idle_user_stream.eligible, false);
    assert.equal(result.flat_idle_user_stream.reason, "bbo_not_fresh");
    assert.equal(result.gates.user_stream_recent_events, false);
    assert.equal(result.gates.bbo_complete, false);
    assert.ok(result.failed_gates.includes("user_stream_recent_events"));
    assert.ok(result.failed_gates.includes("bbo_complete"));
    assert.equal(result.all_passed, false);
  });
});

describe("reconciliationFresh", () => {
  const captureNow = Date.parse("2026-09-22T16:54:00.000Z");
  const healthOk = { data_quality: { issues: [] } };

  function baseOperational(overrides: Record<string, unknown> = {}) {
    return {
      generation: 3,
      reconciliation: {
        state: "succeeded",
        generation: 3,
        lastSucceededAt: "2026-09-22T16:53:40.000Z",
      },
      ...overrides,
    };
  }

  it("passes when generations are present, valid, and equal", () => {
    const result = reconciliationFresh(baseOperational(), healthOk, captureNow, 120_000);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "reconciliation_fresh");
  });

  it("fail-closes when operational.generation is absent", () => {
    const operational = baseOperational();
    delete (operational as { generation?: number }).generation;
    const result = reconciliationFresh(operational, healthOk, captureNow, 120_000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "operational_generation_missing_or_invalid");
  });

  it("fail-closes when reconciliation.generation is absent", () => {
    const operational = baseOperational({
      reconciliation: {
        state: "succeeded",
        lastSucceededAt: "2026-09-22T16:53:40.000Z",
      },
    });
    const result = reconciliationFresh(operational, healthOk, captureNow, 120_000);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "reconciliation_generation_missing_or_invalid");
  });

  it("fail-closes when generation is invalid (non-integer / negative / non-numeric)", () => {
    for (const bad of [1.5, -1, "abc", Number.NaN, null]) {
      const resultOp = reconciliationFresh(
        baseOperational({ generation: bad }),
        healthOk,
        captureNow,
        120_000,
      );
      assert.equal(resultOp.ok, false, `operational generation=${String(bad)}`);
      assert.equal(resultOp.reason, "operational_generation_missing_or_invalid");

      const resultRecon = reconciliationFresh(
        baseOperational({
          reconciliation: {
            state: "succeeded",
            generation: bad,
            lastSucceededAt: "2026-09-22T16:53:40.000Z",
          },
        }),
        healthOk,
        captureNow,
        120_000,
      );
      assert.equal(resultRecon.ok, false, `recon generation=${String(bad)}`);
      assert.equal(resultRecon.reason, "reconciliation_generation_missing_or_invalid");
    }
  });

  it("fail-closes when generations diverge", () => {
    const result = reconciliationFresh(
      baseOperational({
        generation: 3,
        reconciliation: {
          state: "succeeded",
          generation: 1,
          lastSucceededAt: "2026-09-22T16:53:40.000Z",
        },
      }),
      healthOk,
      captureNow,
      120_000,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "reconciliation_generation_mismatch");
  });
});

describe("assessFlatIdleUserStream", () => {
  it("rejects when user hub is disconnected", () => {
    const result = assessFlatIdleUserStream({
      open_orders: {
        confirmed_empty: true,
        ambiguous: false,
        count: 0,
        reason: "openOrders_empty",
        working_orders: [],
      },
      account_flat: true,
      positions_present: true,
      positions_ambiguous: false,
      user_stream: {
        connected: false,
        recent_events: false,
        last_event_at: null,
        age_ms: null,
        reason: "user_stream_not_connected",
      },
      market_stream: {
        connected: true,
        recent_events: true,
        last_event_at: "2026-09-22T16:53:55.000Z",
        age_ms: 5_000,
        reason: "market_stream_ok",
      },
      bbo: {
        complete: true,
        stale: false,
        ambiguous: false,
        bid: 1,
        ask: 2,
        source: "state.quote",
        reason: "ok",
        age_ms: 44,
        age_source: "quote_age_ms",
      },
      operational: {
        generation: 1,
        userStream: { state: "disconnected" },
        marketStream: { state: "connected" },
        reconciliation: {
          state: "succeeded",
          generation: 1,
          lastSucceededAt: "2026-09-22T16:53:40.000Z",
        },
      },
      health: { data_quality: { issues: [] } },
      capture_now_ms: Date.parse("2026-09-22T16:54:00.000Z"),
      reconciliation_max_age_ms: 120_000,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "user_stream_not_connected");
  });
});
