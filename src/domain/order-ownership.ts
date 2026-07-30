import type { OrderInfo, TradeInfo } from "./models.js";
import type { ProtectionStatus, ProtectiveLeg } from "../ownership/protection.js";

export type EntryOrderOwnershipStatus =
  | "provider_acknowledged"
  | "provider_observed"
  | "incomplete";

export interface OwnedFillEvidence {
  evidenceSequence: number;
  trade: TradeInfo;
}

export interface EntryProtection {
  status: ProtectionStatus;
  reason: string;
  stop: ProtectiveLeg;
  target: ProtectiveLeg;
}

export interface EntryOrderOwnership {
  intentId: string;
  account: string | null;
  instrument: string | null;
  action: "ENTER_LONG" | "ENTER_SHORT" | null;
  quantity: number | null;
  plannedStopLoss: number | null;
  plannedTakeProfit: number | null;
  customTag: string | null;
  providerOrderId: number | null;
  status: EntryOrderOwnershipStatus;
  orderEvidenceSequences: number[];
  latestObservedOrder: OrderInfo | null;
  fills: OwnedFillEvidence[];
  effectiveFilledQuantity: number;
  protection: EntryProtection;
  issues: string[];
}

export interface ProjectXOrderOwnershipSnapshot {
  schema_version: "glitch.projectx.order_ownership.v1";
  generated_utc: string;
  account_id: number;
  account_name: string;
  contract_id: string;
  instrument: string;
  entries: EntryOrderOwnership[];
  unresolved_entry_count: number;
  observed_fill_count: number;
  protection_status: ProtectionStatus;
  issues: string[];
  authority: "Only explicit durable provider identities are attributed; price and timing proximity are never ownership evidence.";
}
