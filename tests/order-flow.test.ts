import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredProviderEvidenceEvent } from "../src/domain/provider-evidence.js";
import { buildProjectXOrderFlowObservation } from "../src/market/order-flow.js";

const CONTRACT = "CON.F.US.MNQ.U26";
const GENERATED = new Date("2026-07-21T12:05:00Z");

function event(
  sequence: number,
  eventType: "market_trade" | "depth",
  normalizedPayload: unknown,
  receivedUtc = `2026-07-21T12:04:${String(sequence).padStart(2, "0")}Z`,
): StoredProviderEvidenceEvent {
  return {
    sequence,
    receivedUtc,
    providerTimestampUtc: null,
    source: "projectx_market_stream",
    eventType,
    generation: 1,
    accountId: null,
    contractId: CONTRACT,
    providerEntityId: null,
    relatedProviderEntityId: null,
    payloadHash: `hash-${sequence}`,
    rawPayload: null,
    normalizedPayload,
  };
}

function trade(timestamp: string, type: 0 | 1, price: number, volume: number) {
  return {
    contractId: CONTRACT,
    symbolId: "F.US.MNQ",
    timestamp,
    type,
    price,
    volume,
  };
}

function depth(type: number, price: number, currentVolume: number) {
  return {
    contractId: CONTRACT,
    timestamp: "2026-07-21T12:04:59Z",
    type,
    price,
    volume: currentVolume,
    currentVolume,
  };
}

describe("ProjectX order flow", () => {
  it("computes rolling Buy/Sell tape without producing a strategy signal", () => {
    const observation = buildProjectXOrderFlowObservation({
      contractId: CONTRACT,
      tickSize: 0.25,
      generatedAt: GENERATED,
      coverageStartUtc: "2026-07-21T11:59:00Z",
      events: [
        event(1, "market_trade", trade("2026-07-21T12:00:30Z", 0, 100, 4)),
        event(2, "market_trade", trade("2026-07-21T12:04:48Z", 0, 101, 2)),
        event(3, "market_trade", trade("2026-07-21T12:04:55Z", 1, 102, 1)),
        event(4, "market_trade", trade("2026-07-21T12:04:59Z", 0, 103, 3)),
      ],
    });
    const fifteen = observation.windows.find((window) => window.window_seconds === 15)!;
    const sixty = observation.windows.find((window) => window.window_seconds === 60)!;
    const threeHundred = observation.windows.find((window) => window.window_seconds === 300)!;

    assert.equal(fifteen.trade_count, 3);
    assert.equal(fifteen.buy_volume, 5);
    assert.equal(fifteen.sell_volume, 1);
    assert.equal(fifteen.rolling_delta, 4);
    assert.equal(fifteen.delta_ratio, 4 / 6);
    assert.equal(fifteen.first_price, 101);
    assert.equal(fifteen.last_price, 103);
    assert.equal(sixty.total_volume, 6);
    assert.equal(threeHundred.total_volume, 10);
    assert.equal("signal" in observation, false);
    assert.equal("score" in observation, false);
    assert.equal("action" in observation, false);
    assert.equal(observation.source_complete, true);
  });

  it("reconstructs bounded depth after Reset and removes zero-volume levels", () => {
    const observation = buildProjectXOrderFlowObservation({
      contractId: CONTRACT,
      tickSize: 0.25,
      generatedAt: GENERATED,
      coverageStartUtc: "2026-07-21T11:59:00Z",
      depthLevels: 2,
      events: [
        event(1, "depth", depth(2, 100, 20)),
        event(2, "depth", depth(6, 0, 0)),
        event(3, "depth", depth(2, 100, 10)),
        event(4, "depth", depth(4, 99.75, 5)),
        event(5, "depth", depth(1, 100.25, 8)),
        event(6, "depth", depth(3, 100.5, 4)),
        event(7, "depth", depth(2, 99.75, 0)),
        event(8, "depth", depth(5, 100.25, 1)),
      ],
    });

    assert.equal(observation.depth.reconstruction_basis, "since_latest_reset");
    assert.equal(observation.depth.available, true);
    assert.equal(observation.depth.book_complete, false);
    assert.equal(observation.depth.latest_reset_sequence, 2);
    assert.deepEqual(observation.depth.bid_levels, [
      { price: 100, current_volume: 10 },
    ]);
    assert.deepEqual(observation.depth.ask_levels, [
      { price: 100.25, current_volume: 8 },
      { price: 100.5, current_volume: 4 },
    ]);
    assert.equal(observation.depth.spread_ticks, 1);
    assert.equal(observation.depth.bid_volume, 10);
    assert.equal(observation.depth.ask_volume, 12);
    assert.equal(observation.depth.depth_events_ignored, 1);
  });

  it("reports bounded-window, invalid-event, coverage, and truncation limits", () => {
    const observation = buildProjectXOrderFlowObservation({
      contractId: CONTRACT,
      tickSize: 0.25,
      generatedAt: GENERATED,
      coverageStartUtc: "2026-07-21T12:04:00Z",
      truncated: true,
      events: [
        event(2, "market_trade", { contractId: CONTRACT }),
        event(1, "depth", depth(99, 100, 2)),
      ],
    });

    assert.equal(observation.depth.reconstruction_basis, "bounded_window_without_reset");
    assert.equal(observation.source_complete, false);
    assert.equal(observation.invalid_events, 2);
    assert.ok(observation.issues.includes("input_not_strictly_sequence_ordered"));
    assert.ok(observation.issues.includes("market_evidence_does_not_cover_full_lookback"));
    assert.ok(observation.issues.includes("market_evidence_query_truncated"));
    assert.equal(observation.depth.available, false);
  });
});
