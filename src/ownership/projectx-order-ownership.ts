import type {
  EntryOrderOwnership,
  ProjectXOrderOwnershipSnapshot,
} from "../domain/order-ownership.js";
import type { OrderInfo, TradeInfo, TradeIntent } from "../domain/models.js";
import type { StoredProviderEvidenceEvent } from "../domain/provider-evidence.js";
import { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import { SqliteProviderEvidenceStore } from "../storage/sqlite-provider-evidence-store.js";

export interface ProjectXOrderOwnershipOptions {
  accountId: number;
  contractId: string;
}

export class ProjectXOrderOwnershipService {
  public constructor(
    private readonly execution: SqliteExecutionStore,
    private readonly evidence: SqliteProviderEvidenceStore,
    private readonly options: ProjectXOrderOwnershipOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public current(): ProjectXOrderOwnershipSnapshot {
    const entries = this.execution.submittedEntryMutations().map((mutation) => {
      const intent = this.execution.intentForId(mutation.intentId);
      return this.buildEntry(mutation.intentId, mutation.request, mutation.customTag, mutation.providerOrderId, intent);
    });
    const issues: string[] = [];
    const providerOrderOwners = new Map<number, EntryOrderOwnership[]>();
    for (const entry of entries) {
      if (entry.providerOrderId === null) {
        continue;
      }
      const owners = providerOrderOwners.get(entry.providerOrderId) ?? [];
      owners.push(entry);
      providerOrderOwners.set(entry.providerOrderId, owners);
    }
    for (const [providerOrderId, owners] of providerOrderOwners) {
      if (owners.length < 2) {
        continue;
      }
      const issue = `provider_order_id_shared:${providerOrderId}`;
      issues.push(issue);
      for (const owner of owners) {
        owner.issues.push(issue);
        owner.status = "incomplete";
      }
    }

    return {
      schema_version: "glitch.projectx.order_ownership.v1",
      generated_utc: this.now().toISOString(),
      account_id: this.options.accountId,
      contract_id: this.options.contractId,
      entries,
      unresolved_entry_count: entries.filter((entry) => entry.status !== "provider_observed").length,
      observed_fill_count: entries.reduce(
        (total, entry) => total + entry.fills.filter((fill) => !fill.trade.voided).length,
        0,
      ),
      protection_status: "unknown",
      issues,
      authority: "Only explicit durable provider identities are attributed; price and timing proximity are never ownership evidence.",
    };
  }

  private buildEntry(
    intentId: string,
    request: Record<string, unknown>,
    customTag: string | null,
    providerOrderId: number | null,
    intent: TradeIntent | null,
  ): EntryOrderOwnership {
    const issues: string[] = [];
    let identityComplete = true;

    const requestAccountId = integerValue(request.accountId);
    const requestContractId = stringValue(request.contractId);
    const requestSide = integerValue(request.side);
    const requestType = integerValue(request.type);
    const requestSize = integerValue(request.size);
    if (requestAccountId !== this.options.accountId) {
      issues.push(`request_account_mismatch:${requestAccountId ?? "missing"}`);
      identityComplete = false;
    }
    if (requestContractId !== this.options.contractId) {
      issues.push(`request_contract_mismatch:${requestContractId ?? "missing"}`);
      identityComplete = false;
    }
    if (requestSide !== 0 && requestSide !== 1) {
      issues.push("request_side_invalid");
      identityComplete = false;
    }
    if (requestType !== 2) {
      issues.push(`request_order_type_invalid:${requestType ?? "missing"}`);
      identityComplete = false;
    }
    if (requestSize === null || requestSize < 1) {
      issues.push("request_size_invalid");
      identityComplete = false;
    }
    if (customTag === null) {
      issues.push("custom_tag_missing");
      identityComplete = false;
    }
    if (providerOrderId === null) {
      issues.push("provider_order_id_missing");
      identityComplete = false;
    }

    const action = intent?.action === "ENTER_LONG" || intent?.action === "ENTER_SHORT"
      ? intent.action
      : null;
    if (!intent) {
      issues.push("intent_missing");
      identityComplete = false;
    } else if (action === null) {
      issues.push(`intent_action_invalid:${intent.action}`);
      identityComplete = false;
    }
    if (action === "ENTER_LONG" && requestSide !== 0) {
      issues.push("intent_request_side_mismatch");
      identityComplete = false;
    }
    if (action === "ENTER_SHORT" && requestSide !== 1) {
      issues.push("intent_request_side_mismatch");
      identityComplete = false;
    }
    if (intent?.quantity !== requestSize) {
      issues.push("intent_request_quantity_mismatch");
      identityComplete = false;
    }

    const orderEvents = providerOrderId === null
      ? []
      : this.orderEvidence(providerOrderId);
    const orderEvidenceSequences = orderEvents.map((event) => event.sequence);
    const observedOrders = orderEvents
      .map((event) => orderFromEvidence(event, providerOrderId))
      .filter((order): order is OrderInfo => order !== null);
    const latestObservedOrder = observedOrders.at(-1) ?? null;
    if (latestObservedOrder) {
      if (customTag !== null && latestObservedOrder.customTag !== null && latestObservedOrder.customTag !== customTag) {
        issues.push("observed_order_custom_tag_mismatch");
        identityComplete = false;
      }
      if (latestObservedOrder.side !== requestSide) {
        issues.push("observed_order_side_mismatch");
        identityComplete = false;
      }
      if (latestObservedOrder.type !== requestType) {
        issues.push("observed_order_type_mismatch");
        identityComplete = false;
      }
      if (latestObservedOrder.size !== requestSize) {
        issues.push("observed_order_size_mismatch");
        identityComplete = false;
      }
    }

    const fills = providerOrderId === null
      ? []
      : this.fillEvidence(providerOrderId, issues);
    const status = !identityComplete
      ? "incomplete"
      : latestObservedOrder
        ? "provider_observed"
        : "provider_acknowledged";

    return {
      intentId,
      account: intent?.account ?? null,
      instrument: intent?.instrument ?? null,
      action,
      quantity: intent?.quantity ?? requestSize,
      plannedStopLoss: intent?.stopLoss ?? null,
      plannedTakeProfit: intent?.takeProfit1 ?? null,
      customTag,
      providerOrderId,
      status,
      orderEvidenceSequences,
      latestObservedOrder,
      fills,
      effectiveFilledQuantity: fills.reduce(
        (total, fill) => total + (fill.trade.voided ? 0 : fill.trade.size),
        0,
      ),
      protection: {
        status: "unknown",
        reason: "provider_child_order_relation_not_observed",
      },
      issues,
    };
  }

  private orderEvidence(providerOrderId: number): StoredProviderEvidenceEvent[] {
    const direct = this.evidence.query({
      source: "projectx_user_stream",
      eventType: "order",
      accountId: this.options.accountId,
      contractId: this.options.contractId,
      providerEntityId: String(providerOrderId),
      limit: 10_000,
    });
    const snapshots = this.evidence.query({
      source: "projectx_rest",
      eventType: "open_orders_snapshot",
      accountId: this.options.accountId,
      contractId: this.options.contractId,
      limit: 10_000,
    }).filter((event) => snapshotContainsOrder(event, providerOrderId));
    return [...direct, ...snapshots].sort((left, right) => left.sequence - right.sequence);
  }

  private fillEvidence(
    providerOrderId: number,
    issues: string[],
  ): Array<{ evidenceSequence: number; trade: TradeInfo }> {
    const events = this.evidence.query({
      source: "projectx_user_stream",
      eventType: "trade",
      accountId: this.options.accountId,
      contractId: this.options.contractId,
      relatedProviderEntityId: String(providerOrderId),
      limit: 10_000,
    });
    const latestByTradeId = new Map<number, { evidenceSequence: number; trade: TradeInfo }>();
    for (const event of events) {
      const trade = tradeFromEvidence(event, providerOrderId);
      if (!trade) {
        issues.push(`trade_evidence_invalid:${event.sequence}`);
        continue;
      }
      latestByTradeId.set(trade.id, {
        evidenceSequence: event.sequence,
        trade,
      });
    }
    return [...latestByTradeId.values()].sort(
      (left, right) => left.evidenceSequence - right.evidenceSequence,
    );
  }
}

function snapshotContainsOrder(
  event: StoredProviderEvidenceEvent,
  providerOrderId: number,
): boolean {
  return Array.isArray(event.normalizedPayload)
    && event.normalizedPayload.some((value) => isOrderInfo(value) && value.id === providerOrderId);
}

function orderFromEvidence(
  event: StoredProviderEvidenceEvent,
  providerOrderId: number,
): OrderInfo | null {
  if (event.eventType === "order") {
    return isOrderInfo(event.normalizedPayload) && event.normalizedPayload.id === providerOrderId
      ? event.normalizedPayload
      : null;
  }
  if (!Array.isArray(event.normalizedPayload)) {
    return null;
  }
  return event.normalizedPayload.find(
    (value): value is OrderInfo => isOrderInfo(value) && value.id === providerOrderId,
  ) ?? null;
}

function tradeFromEvidence(
  event: StoredProviderEvidenceEvent,
  providerOrderId: number,
): TradeInfo | null {
  return isTradeInfo(event.normalizedPayload) && event.normalizedPayload.orderId === providerOrderId
    ? event.normalizedPayload
    : null;
}

function isOrderInfo(value: unknown): value is OrderInfo {
  if (!isRecord(value)) {
    return false;
  }
  return integerValue(value.id) !== null
    && integerValue(value.accountId) !== null
    && stringValue(value.contractId) !== null
    && stringValue(value.creationTimestamp) !== null
    && stringValue(value.updateTimestamp) !== null
    && integerValue(value.status) !== null
    && integerValue(value.type) !== null
    && integerValue(value.side) !== null
    && integerValue(value.size) !== null
    && nullableFiniteNumber(value.limitPrice)
    && nullableFiniteNumber(value.stopPrice);
}

function isTradeInfo(value: unknown): value is TradeInfo {
  if (!isRecord(value)) {
    return false;
  }
  return integerValue(value.id) !== null
    && integerValue(value.accountId) !== null
    && stringValue(value.contractId) !== null
    && stringValue(value.creationTimestamp) !== null
    && finiteNumber(value.price)
    && nullableFiniteNumber(value.profitAndLoss)
    && nullableFiniteNumber(value.fees)
    && integerValue(value.side) !== null
    && integerValue(value.size) !== null
    && typeof value.voided === "boolean"
    && integerValue(value.orderId) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableFiniteNumber(value: unknown): boolean {
  return value === null || value === undefined || finiteNumber(value);
}
