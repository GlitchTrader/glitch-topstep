import type {
  AccountInfo,
  ContractInfo,
  MarketDepthInfo,
  MarketTradeInfo,
  OrderInfo,
  PositionInfo,
  QuoteInfo,
  TradeInfo,
} from "./models.js";

export interface ReplaySequenceGap {
  after_sequence: number;
  before_sequence: number;
  missing_count: number;
}

export interface ProjectXEvidenceReplaySnapshot {
  schema_version: "glitch.projectx.evidence_replay.v1";
  requested_through_sequence: number | null;
  through_sequence: number;
  first_sequence: number | null;
  last_received_utc: string | null;
  events_read: number;
  events_applied: number;
  events_ignored: number;
  events_invalid: number;
  truncated: boolean;
  evidence_complete: boolean;
  sequence_gaps: ReplaySequenceGap[];
  event_counts: Record<string, number>;
  accounts: AccountInfo[];
  contracts: ContractInfo[];
  positions: PositionInfo[];
  open_orders: OrderInfo[];
  order_history: OrderInfo[];
  trades: TradeInfo[];
  quotes: QuoteInfo[];
  latest_market_trades: MarketTradeInfo[];
  latest_depth: MarketDepthInfo[];
  issues: string[];
  state_hash: string;
  evidence_hash: string;
}

export interface ProjectXEvidenceReplayOptions {
  throughSequence?: number;
  maxEvents?: number;
  batchSize?: number;
}
