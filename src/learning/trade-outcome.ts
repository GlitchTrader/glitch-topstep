export const TRADE_OUTCOME_SCHEMA = "glitch.topstep.trade_outcome.v1" as const;

export type TradeOutcomeExitReason =
  | "take_profit"
  | "stop_loss"
  | "manual_exit"
  | "flatten"
  | "reconciliation"
  | "unknown";

export interface TradeOutcomeFill {
  price: number;
  size: number;
  side: number;
  order_id: number;
  timestamp: string;
  profit_and_loss: number | null;
  fees: number | null;
}

export interface TradeOutcomeV1 {
  schema_version: typeof TRADE_OUTCOME_SCHEMA;
  outcome_id: string;
  intent_id: string;
  account: string;
  instrument: string;
  entry_utc: string;
  exit_utc: string;
  realized_pnl_usd: number;
  fees_usd: number;
  learning_eligible: boolean;
  exit_reason?: TradeOutcomeExitReason | string;
  attribution?: {
    entry_order_id: number | null;
    trade_count: number;
    protection_status: string;
  };
  // v1.1 optional enrichment (required for learning_eligible when publisher version supports it)
  fills?: TradeOutcomeFill[];
  entry_price?: number | null;
  exit_price?: number | null;
  stop_price?: number | null;
  target_price?: number | null;
  quantity?: number | null;
  side?: "long" | "short" | null;
  slippage_ticks?: number | null;
  mae_usd?: number | null;
  mfe_usd?: number | null;
  mae_ticks?: number | null;
  mfe_ticks?: number | null;
  initial_risk_usd?: number | null;
  r_multiple?: number | null;
  buffer_impact_usd?: number | null;
  protection_confirmed?: boolean;
  packet_id?: string | null;
  snapshot_hash?: string | null;
  evidence?: {
    publisher_version: string;
    trade_ids: number[];
    order_ids: number[];
  };
}

export const TRADE_OUTCOME_PUBLISHER_VERSION = "0.1.3-r3-03c";

export function tradeOutcomeId(intentId: string): string {
  return `outcome:${intentId}`;
}
