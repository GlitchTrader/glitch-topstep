export interface CanonicalBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarGap {
  afterUtc: string;
  beforeUtc: string;
  missingBars: number;
}

export interface DescriptiveMarketFeatures {
  latestClose: number;
  change: number | null;
  returnBps: number | null;
  trueRange: number;
  averageTrueRange14: number | null;
  realizedVolatility20Bps: number | null;
  rollingVwap20: number | null;
  distanceFromRollingVwap20Bps: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  distanceFromEma20Bps: number | null;
  distanceFromEma50Bps: number | null;
  distanceFromEma200Bps: number | null;
  ema20SlopeBps: number | null;
  ema50SlopeBps: number | null;
  ema200SlopeBps: number | null;
  rangePosition20: number | null;
  closeLocation: number | null;
  bodyFraction: number | null;
  upperWickFraction: number | null;
  lowerWickFraction: number | null;
  volumeZScore20: number | null;
}

export interface TimeframeObservation {
  timeframeMinutes: 1 | 5 | 15 | 60;
  barsAvailable: number;
  latestBarUtc: string | null;
  latestBarPartial: boolean;
  gaps: BarGap[];
  features: DescriptiveMarketFeatures | null;
}

export interface MultiTimeframeObservation {
  schema_version: "glitch.market_observation.v1";
  generated_utc: string;
  source: "projectx_bars" | "replay";
  instrument: string;
  contract_id: string;
  one_minute_bars_received: number;
  one_minute_bars_accepted: number;
  rejected_bar_count: number;
  timeframes: TimeframeObservation[];
}
