import type { OrderInfo, TradeInfo } from "./models.js";

export type EntryOrderOwnershipStatus =
  | "provider_acknowledged"
  | "provider_observed"
  | "incomplete";

export interface OwnedFillEvidence {
  evidenceSequence: number;
  trade: TradeInfo;
}

export interface EntryOrderOwnership {
  intentId: string;
  account: string;
  instrument: string;
  action: "ENTER_LONG" | "ENTER_SHORT";
  quantity: number;
  plannedStopLoss: number;
  plannedTakeProfit: number;
  customTag: string;
  providerOrderId: number | null;
  status: EntryOrderOwnershipStatus;
  orderEvidenceSequences: number[];
  latestObservedOrder: OrderInfo | null;
  fills: OwnedFillEvidence[];
  effectiveFilledQuantity: number;
  protection: {
    status: "unknown";
    reason: "provider_child_order_relation_not_observed";
  };
  issues: string[];
}

export interface ProjectXOrderOwnershipSnapshot {
  schema_version: "glitch.projectx.order_ownership.v1";
  generated_utc: string;
  account_id: number;
  contract_id: string;
  entries: EntryOrderOwnership[];
  unresolved_entry_count: number;
  observed_fill_count: number;
  protection_status: "unknown";
  authority: "Only explicit durable provider identities are attributed; price and timing proximity are never ownership evidence.";
}
