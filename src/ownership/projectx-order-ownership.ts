import { DatabaseSync } from "node:sqlite";
import type {
  EntryOrderOwnership,
  OwnedFillEvidence,
  ProjectXOrderOwnershipSnapshot,
} from "../domain/order-ownership.js";
import type { OrderInfo, TradeInfo, TradeIntent } from "../domain/models.js";
import type { StoredProviderEvidenceEvent } from "../domain/provider-evidence.js";
import { SqliteProviderEvidenceStore } from "../storage/sqlite-provider-evidence-store.js";

export interface ProjectXOrderOwnershipOptions {
  accountId: number;
  accountName: string;
  contractId: string;
  instrument: string;
}

interface SubmittedEntryRow {
  intent_id: string;
  custom_tag: string | null;
  request_json: string;
  provider_order_id: number | bigint | null;
  intent_json: string;
}

export class ProjectXOrderOwnershipService {
  private readonly executionDatabase: DatabaseSync;

  public constructor(
    executionDatabasePath: string,
    private readonly evidence: SqliteProviderEvidenceStore,
    private readonly options: ProjectXOrderOwnershipOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.executionDatabase = new DatabaseSync(executionDatabasePath);
    this.executionDatabase.exec("PRAGMA query_only=ON");
    this.executionDatabase.exec("PRAGMA busy_timeout=5000");
  }

  public close(): void {
    this.executionDatabase.close();
  }

  public current(): ProjectXOrderOwnershipSnapshot {
    const rows = this.executionDatabase.prepare(`
      SELECT
        outbox.intent_id,
        outbox.custom_tag,
        outbox.request_json,
        outbox.provider_order_id,
        intent.payload_json AS intent_json
      FROM execution_outbox AS outbox
      JOIN intents AS intent ON intent.intent_id = outbox.intent_id
      WHERE outbox.operation = 'place_order'
        AND outbox.state = 'submitted'
      ORDER BY outbox.created_utc ASC, outbox.intent_id ASC
    `).all() as unknown as SubmittedEntryRow[];

    const entries = rows.map((row) => this.buildEntry(row));
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
      account_name: this.options.accountName,
      contract_id: this.options.contractId,
      instrument: this.options.instrument,
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

  private buildEntry(row: SubmittedEntryRow): EntryOrderOwnership {
    const issues: string[] = [];
    let identityComplete = true;
    const request = parseRecord(row.request_json, "execution_request", issues);
    const intent = parseIntent(row.intent_json, issues);
    const providerOrderId = row.provider_order_id === null
      ? null
      : Number(row.provider_order_id);
    const customTag = row.custom_tag;

    const requestAccountId = integerValue(request?.accountId);
    const requestContractId = stringValue(request?.contractId);
    const requestSide = integerValue(request?.side);
    const requestType = integerValue(request?.type);
    const requestSize = integerValue(request?.size);
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
    if (providerOrderId === null || !Number.isInteger(providerOrderId)) {
      issues.push("provider_order_id_missing");
      identityComplete = false;
    }

    const action = intent?.action === "ENTER_LONG" || intent?.action === "ENTER_SHORT"
      ? intent.action
      : null;
    if (!intent) {
      identityComplete = false;
    } else {
      if (intent.account !== this.options.accountName) {
        issues.push(`intent_account_mismatch:${intent.account}`);
        identityComplete = false;
      }
      if (intent.instrument.toUpperCase() !== this.options.instrument.toUpperCase()) {
        issues.push(`intent_instrument_mismatch:${intent.instrument}`);
        identityComplete = false;
      }
      if (action === null) {
        issues.push(`intent_action_invalid:${intent.action}`);
        identityComplete = false;
      }
      if (intent.quantity !== requestSize) {
        issues.push("intent_request_quantity_mismatch");
        identityComplete = false;
      }
    }
    if (action === "ENTER_LONG" && requestSide !== 0) {
      issues.push("intent_request_side_mismatch");
      identityComplete = false;
    }
    if (action === "ENTER_SHORT" && requestSide !== 1) {
      issues.push("intent_request_side_mismatch");
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
      if (latestObservedOrder.accountId !== this.options.accountId) {
        issues.push("observed_order_account_mismatch");
        identityComplete = false;
      }
      if (latestObservedOrder.contractId !== this.options.contractId) {
        issues.push("observed_order_contract_mismatch");
        identityComplete = false;
      }
      if (
        customTag !== null
        && latestObservedOrder.customTag !== null
        && latestObservedOrder.customTag !== undefined
        && latestObservedOrder.customTag !== customTag
      ) {
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
      : this.fillEvidence(providerOrderId, requestSide, issues);
    const effectiveFilledQuantity = fills.reduce(
      (total, fill) => total + (fill.trade.voided ? 0 : fill.trade.size),
      0,
    );
    if (requestSize !== null && effectiveFilledQuantity > requestSize) {
      issues.push(`fill_quantity_exceeds_order:${effectiveFilledQuantity}>${requestSize}`);
      identityComplete = false;
    }
    if (issues.some((issue) => issue.startsWith("fill_") || issue.startsWith("trade_"))) {
      identityComplete = false;
    }

    const providerObserved = latestObservedOrder !== null || fills.length > 0;
    const status = !identityComplete
      ? "incomplete"
      : providerObserved
        ? "provider_observed"
        : "provider_acknowledged";

    return {
      intentId: row.intent_id,
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
      effectiveFilledQuantity,
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
    requestSide: number | null,
    issues: string[],
  ): OwnedFillEvidence[] {
    const events = this.evidence.query({
      source: "projectx_user_stream",
      eventType: "trade",
      accountId: this.options.accountId,
      contractId: this.options.contractId,
      relatedProviderEntityId: String(providerOrderId),
      limit: 10_000,
    });
    const latestByTradeId = new Map<number, OwnedFillEvidence>();
    for (const event of events) {
      const trade = tradeFromEvidence(event, providerOrderId);
      if (!trade) {
        issues.push(`trade_evidence_invalid:${event.sequence}`);
        continue;
      }
      if (trade.accountId !== this.options.accountId) {
        issues.push(`fill_account_mismatch:${trade.id}`);
      }
      if (trade.contractId !== this.options.contractId) {
        issues.push(`fill_contract_mismatch:${trade.id}`);
      }
      if (requestSide !== null && trade.side !== requestSide) {
        issues.push(`fill_side_mismatch:${trade.id}`);
      }
      if (!Number.isInteger(trade.size) || trade.size < 1) {
        issues.push(`fill_size_invalid:${trade.id}`);
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

function parseRecord(
  input: string,
  name: string,
  issues: string[],
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!isRecord(parsed)) {
      issues.push(`${name}_invalid`);
      return null;
    }
    return parsed;
  } catch {
    issues.push(`${name}_invalid_json`);
    return null;
  }
}

function parseIntent(input: string, issues: string[]): TradeIntent | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!isTradeIntent(parsed)) {
      issues.push("intent_invalid");
      return null;
    }
    return parsed;
  } catch {
    issues.push("intent_invalid_json");
    return null;
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

function isTradeIntent(value: unknown): value is TradeIntent {
  if (!isRecord(value)) {
    return false;
  }
  return value.schemaVersion === "glitch.intent.v2"
    && stringValue(value.intentId) !== null
    && stringValue(value.account) !== null
    && stringValue(value.instrument) !== null
    && stringValue(value.action) !== null;
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
