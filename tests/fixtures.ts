import type { AccountVenueSnapshot, VenueOperationalStatus } from "../src/domain/models.js";
import type { ProjectXOrderFlowState } from "../src/domain/order-flow.js";

export function orderFlowWithTrades(tradeCount: number): ProjectXOrderFlowState {
  return {
    last_attempt_utc: "2026-07-21T12:00:00Z",
    last_succeeded_utc: "2026-07-21T12:00:00Z",
    last_error: null,
    observation: {
      schema_version: "glitch.projectx.order_flow.v1",
      generated_utc: "2026-07-21T12:00:00Z",
      source: "projectx_market_evidence",
      contract_id: "CON.F.US.MNQ.U26",
      lookback_start_utc: "2026-07-21T11:59:00Z",
      through_sequence: 1,
      events_read: 1,
      truncated: false,
      source_complete: true,
      invalid_events: 0,
      windows: [
        {
          window_seconds: 60,
          start_utc: "2026-07-21T11:59:00Z",
          end_utc: "2026-07-21T12:00:00Z",
          trade_count: tradeCount,
          total_volume: tradeCount,
          buy_volume: tradeCount,
          sell_volume: 0,
          rolling_delta: tradeCount,
          delta_ratio: 1,
          average_trade_size: 1,
          max_trade_size: 1,
          vwap: 20_000,
          first_price: 20_000,
          last_price: 20_000,
          high_price: 20_000,
          low_price: 20_000,
          price_change: 0,
          price_change_bps: 0,
          trades_per_second: tradeCount / 60,
        },
      ],
      depth: {
        depth_levels_requested: 10,
        reconstruction_basis: "bounded_window_without_reset",
        book_complete: false,
        latest_reset_sequence: null,
        best_bid: 19_999.75,
        best_ask: 20_000.25,
        spread_ticks: 2,
        bid_volume: 10,
        ask_volume: 12,
        imbalance_ratio: -0.09,
        bid_levels: [],
        ask_levels: [],
        depth_events_applied: 1,
        depth_events_ignored: 0,
        depth_events_invalid: 0,
      },
      issues: [],
    },
  };
}

export function operational(): VenueOperationalStatus {
  return {
    generation: 1,
    userStream: {
      state: "connected",
      generation: 1,
      lastChangedAt: "2026-07-21T12:00:00Z",
      lastEventAt: "2026-07-21T12:00:04Z",
      lastError: null,
    },
    marketStream: {
      state: "connected",
      generation: 1,
      lastChangedAt: "2026-07-21T12:00:00Z",
      lastEventAt: "2026-07-21T12:00:04Z",
      lastError: null,
    },
    reconciliation: {
      state: "succeeded",
      generation: 1,
      lastStartedAt: "2026-07-21T12:00:03Z",
      lastSucceededAt: "2026-07-21T12:00:04Z",
      lastError: null,
    },
  };
}

export function snapshot(): AccountVenueSnapshot {
  return {
    capturedAt: "2026-07-21T12:00:04Z",
    account: {
      id: 101,
      name: "TEST_ACCOUNT",
      balance: 1_000,
      canTrade: true,
      isVisible: true,
      simulated: true,
    },
    contract: {
      id: "CON.F.US.MNQ.U26",
      name: "MNQU6",
      description: "Micro E-mini Nasdaq",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    },
    quote: {
      contractId: "CON.F.US.MNQ.U26",
      symbol: "F.US.MNQ",
      lastPrice: 20_000,
      bestBid: 19_999.75,
      bestAsk: 20_000.25,
      open: 19_950,
      high: 20_020,
      low: 19_930,
      volume: 10_000,
      timestamp: "2026-07-21T12:00:04Z",
    },
    positions: [],
    openOrders: [],
    totalOpenContracts: 0,
    instrumentOpenContracts: 0,
    unrealizedPnl: 0,
    conservativeEquity: 1_000,
    operational: operational(),
    stateIssues: [],
    stateComplete: true,
  };
}
