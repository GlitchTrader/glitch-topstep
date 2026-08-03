export const TRADE_OUTCOME_SCHEMA = "glitch.topstep.trade_outcome.v1" as const;

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
  exit_reason?: string;
  attribution?: {
    entry_order_id: number | null;
    trade_count: number;
    protection_status: string;
  };
}

export function tradeOutcomeId(intentId: string): string {
  return `outcome:${intentId}`;
}
