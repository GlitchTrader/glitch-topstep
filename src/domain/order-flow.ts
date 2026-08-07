export type OrderFlowWindowSeconds = 15 | 60 | 300;

export interface RollingTapeObservation {
  window_seconds: OrderFlowWindowSeconds;
  start_utc: string;
  end_utc: string;
  trade_count: number;
  total_volume: number;
  buy_volume: number;
  sell_volume: number;
  rolling_delta: number;
  delta_ratio: number | null;
  average_trade_size: number | null;
  max_trade_size: number | null;
  vwap: number | null;
  first_price: number | null;
  last_price: number | null;
  high_price: number | null;
  low_price: number | null;
  price_change: number | null;
  price_change_bps: number | null;
  trades_per_second: number;
}

export interface DepthLevelObservation {
  price: number;
  current_volume: number;
}

export interface DepthBookObservation {
  available: boolean;
  depth_levels_requested: number;
  reconstruction_basis: "since_latest_reset" | "bounded_window_without_reset";
  book_complete: false;
  latest_reset_sequence: number | null;
  best_bid: number | null;
  best_ask: number | null;
  spread_ticks: number | null;
  bid_volume: number;
  ask_volume: number;
  imbalance_ratio: number | null;
  bid_levels: DepthLevelObservation[];
  ask_levels: DepthLevelObservation[];
  depth_events_applied: number;
  depth_events_ignored: number;
  depth_events_invalid: number;
}

export interface ProjectXOrderFlowObservation {
  schema_version: "glitch.projectx.order_flow.v1";
  generated_utc: string;
  source: "projectx_market_evidence" | "replay";
  contract_id: string;
  lookback_start_utc: string;
  through_sequence: number;
  events_read: number;
  truncated: boolean;
  source_complete: boolean;
  invalid_events: number;
  windows: RollingTapeObservation[];
  depth: DepthBookObservation;
  issues: string[];
  /** Most recent market_trade timestamp in the 300s lookback, when any trade exists. */
  last_trade_utc: string | null;
}

export interface ProjectXOrderFlowState {
  last_attempt_utc: string | null;
  last_succeeded_utc: string | null;
  last_error: string | null;
  observation: ProjectXOrderFlowObservation | null;
}
