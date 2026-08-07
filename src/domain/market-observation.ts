export type MarketObservationTimeframeMinutes = 1 | 5 | 15 | 60;

export interface CanonicalMarketBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketBarGap {
  after_utc: string;
  before_utc: string;
  missing_bars: number;
}

export interface DescriptiveMarketFeatures {
  latest_close: number;
  change: number | null;
  return_bps: number | null;
  true_range: number;
  average_true_range_14: number | null;
  realized_volatility_20_bps: number | null;
  rolling_vwap_20: number | null;
  distance_from_rolling_vwap_20_bps: number | null;
  ema_20: number | null;
  ema_50: number | null;
  ema_200: number | null;
  distance_from_ema_20_bps: number | null;
  distance_from_ema_50_bps: number | null;
  distance_from_ema_200_bps: number | null;
  ema_20_slope_bps: number | null;
  ema_50_slope_bps: number | null;
  ema_200_slope_bps: number | null;
  range_position_20: number | null;
  close_location: number | null;
  body_fraction: number | null;
  upper_wick_fraction: number | null;
  lower_wick_fraction: number | null;
  volume_z_score_20: number | null;
  progress_adjusted_volume_z_score_20: number | null;
}

export interface TimeframeMarketObservation {
  timeframe_minutes: MarketObservationTimeframeMinutes;
  bars_received: number;
  bars_accepted: number;
  rejected_bars: number;
  latest_bar_utc: string | null;
  latest_bar_partial: boolean;
  gaps: MarketBarGap[];
  features: DescriptiveMarketFeatures | null;
}

export interface MultiTimeframeMarketObservation {
  schema_version: "glitch.projectx.market_observation.v1";
  generated_utc: string;
  source: "projectx_bars" | "replay";
  instrument: string;
  contract_id: string;
  timeframes: TimeframeMarketObservation[];
}

export interface MarketObservationState {
  last_attempt_utc: string | null;
  last_succeeded_utc: string | null;
  last_error: string | null;
  observation: MultiTimeframeMarketObservation | null;
}
