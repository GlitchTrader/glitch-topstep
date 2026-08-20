import assert from "node:assert/strict";
import test from "node:test";
import { emptyOrderFlowState } from "../src/hermes/packet-builder.js";
import { buildPriceDeltaRelationship } from "../src/market/price-delta-relationship.js";

test("buildPriceDeltaRelationship classifies aligned price and delta", () => {
  const orderFlow = emptyOrderFlowState();
  orderFlow.observation = {
    schema_version: "glitch.projectx.order_flow.v1",
    generated_utc: "2026-08-20T19:00:00.000Z",
    source: "projectx_market_evidence",
    contract_id: "CON.F.US.MNQ.U26",
    lookback_start_utc: "2026-08-20T18:55:00.000Z",
    through_sequence: 1,
    events_read: 1,
    truncated: false,
    source_complete: true,
    invalid_events: 0,
    windows: [{
      window_seconds: 60,
      start_utc: "2026-08-20T18:59:00.000Z",
      end_utc: "2026-08-20T19:00:00.000Z",
      trade_count: 10,
      total_volume: 10,
      buy_volume: 6,
      sell_volume: 4,
      rolling_delta: 2,
      delta_ratio: 0.2,
      average_trade_size: 1,
      max_trade_size: 1,
      vwap: 100,
      first_price: 99,
      last_price: 101,
      high_price: 101,
      low_price: 99,
      price_change: 2,
      price_change_bps: 20,
      trades_per_second: 0.1,
    }],
    depth: {
      available: false,
      unavailable_reason: null,
      depth_levels_requested: 10,
      reconstruction_basis: "bounded_window_without_reset",
      book_complete: false,
      latest_reset_sequence: null,
      best_bid: null,
      best_ask: null,
      spread_ticks: null,
      bid_volume: 0,
      ask_volume: 0,
      imbalance_ratio: null,
      bid_levels: [],
      ask_levels: [],
      depth_events_applied: 0,
      depth_events_ignored: 0,
      depth_events_invalid: 0,
    },
    issues: [],
    last_trade_utc: null,
  };
  const packet = buildPriceDeltaRelationship(orderFlow, "2026-08-20T19:00:00.000Z");
  assert.equal(packet.windows[1]?.alignment, "aligned");
  assert.equal(packet.summary, "aligned");
});
