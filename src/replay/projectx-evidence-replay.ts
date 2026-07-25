import { createHash, type Hash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AccountInfo,
  ContractInfo,
  MarketDepthInfo,
  MarketTradeInfo,
  OrderInfo,
  PositionInfo,
  QuoteInfo,
  TradeInfo,
} from "../domain/models.js";
import type {
  ProjectXEvidenceReplayOptions,
  ProjectXEvidenceReplaySnapshot,
  ReplaySequenceGap,
} from "../domain/provider-replay.js";
import type { StoredProviderEvidenceEvent } from "../domain/provider-evidence.js";

interface EvidenceRow {
  sequence: number | bigint;
  received_utc: string;
  provider_timestamp_utc: string | null;
  source: string;
  event_type: string;
  generation: number | bigint;
  account_id: number | bigint | null;
  contract_id: string | null;
  provider_entity_id: string | null;
  related_provider_entity_id: string | null;
  payload_hash: string;
  raw_payload_json: string;
  normalized_payload_json: string;
}

const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_EVENTS = 1_000_000;
const MAX_BATCH_SIZE = 10_000;
const MAX_EVENTS = 5_000_000;
const TERMINAL_ORDER_STATUSES = new Set([2, 3, 4, 5]);

export class ProjectXEvidenceReplayService {
  private readonly database: DatabaseSync;

  public constructor(evidenceDatabasePath: string) {
    this.database = new DatabaseSync(evidenceDatabasePath);
    this.database.exec("PRAGMA query_only=ON");
    this.database.exec("PRAGMA busy_timeout=5000");
  }

  public close(): void {
    this.database.close();
  }

  public replay(options: ProjectXEvidenceReplayOptions = {}): ProjectXEvidenceReplaySnapshot {
    const throughSequence = optionalInteger(
      options.throughSequence,
      "provider_replay_through_sequence_invalid",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const maxEvents = integerOption(
      options.maxEvents,
      DEFAULT_MAX_EVENTS,
      "provider_replay_max_events_invalid",
      1,
      MAX_EVENTS,
    );
    const batchSize = integerOption(
      options.batchSize,
      DEFAULT_BATCH_SIZE,
      "provider_replay_batch_size_invalid",
      1,
      MAX_BATCH_SIZE,
    );
    const reducer = new ProjectXEvidenceReplayReducer(throughSequence ?? null);
    let afterSequence = 0;
    let remaining = maxEvents;

    while (remaining > 0) {
      const limit = Math.min(batchSize, remaining);
      const rows = this.readBatch(afterSequence, throughSequence, limit);
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        reducer.apply(fromRow(row));
      }
      afterSequence = Number(rows.at(-1)!.sequence);
      remaining -= rows.length;
      if (rows.length < limit) {
        break;
      }
    }

    const truncated = remaining === 0 && this.hasEventAfter(afterSequence, throughSequence);
    return reducer.snapshot(truncated);
  }

  private readBatch(
    afterSequence: number,
    throughSequence: number | undefined,
    limit: number,
  ): EvidenceRow[] {
    try {
      if (throughSequence === undefined) {
        return this.database.prepare(`
          SELECT
            sequence,
            received_utc,
            provider_timestamp_utc,
            source,
            event_type,
            generation,
            account_id,
            contract_id,
            provider_entity_id,
            related_provider_entity_id,
            payload_hash,
            raw_payload_json,
            normalized_payload_json
          FROM provider_events
          WHERE sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(afterSequence, limit) as unknown as EvidenceRow[];
      }
      return this.database.prepare(`
        SELECT
          sequence,
          received_utc,
          provider_timestamp_utc,
          source,
          event_type,
          generation,
          account_id,
          contract_id,
          provider_entity_id,
          related_provider_entity_id,
          payload_hash,
          raw_payload_json,
          normalized_payload_json
        FROM provider_events
        WHERE sequence > ? AND sequence <= ?
        ORDER BY sequence ASC
        LIMIT ?
      `).all(afterSequence, throughSequence, limit) as unknown as EvidenceRow[];
    } catch (error) {
      throw replayDatabaseError(error);
    }
  }

  private hasEventAfter(afterSequence: number, throughSequence: number | undefined): boolean {
    try {
      const row = throughSequence === undefined
        ? this.database.prepare(`
            SELECT 1 AS present
            FROM provider_events
            WHERE sequence > ?
            LIMIT 1
          `).get(afterSequence)
        : this.database.prepare(`
            SELECT 1 AS present
            FROM provider_events
            WHERE sequence > ? AND sequence <= ?
            LIMIT 1
          `).get(afterSequence, throughSequence);
      return row !== undefined;
    } catch (error) {
      throw replayDatabaseError(error);
    }
  }
}

export function replayProviderEvidence(
  events: StoredProviderEvidenceEvent[],
  requestedThroughSequence: number | null = null,
): ProjectXEvidenceReplaySnapshot {
  const originalSequences = events.map((event) => event.sequence);
  const sorted = [...events]
    .filter((event) => requestedThroughSequence === null || event.sequence <= requestedThroughSequence)
    .sort((left, right) => (
      left.sequence - right.sequence || left.payloadHash.localeCompare(right.payloadHash)
    ));
  const reducer = new ProjectXEvidenceReplayReducer(requestedThroughSequence);
  if (!isStrictlyAscending(originalSequences)) {
    reducer.addIssue("input_not_strictly_sequence_ordered");
  }
  for (const event of sorted) {
    reducer.apply(event);
  }
  return reducer.snapshot(false);
}

class ProjectXEvidenceReplayReducer {
  private readonly accounts = new Map<number, AccountInfo>();
  private readonly contracts = new Map<string, ContractInfo>();
  private readonly positions = new Map<number, PositionInfo>();
  private readonly openOrders = new Map<number, OrderInfo>();
  private readonly orderHistory = new Map<number, OrderInfo>();
  private readonly trades = new Map<number, TradeInfo>();
  private readonly quotes = new Map<string, QuoteInfo>();
  private readonly marketTrades = new Map<string, MarketTradeInfo>();
  private readonly depth = new Map<string, MarketDepthInfo>();
  private readonly eventCounts = new Map<string, number>();
  private readonly issues: string[] = [];
  private readonly sequenceGaps: ReplaySequenceGap[] = [];
  private readonly evidenceHasher: Hash = createHash("sha256");
  private firstSequence: number | null = null;
  private previousSequence = 0;
  private throughSequence = 0;
  private lastReceivedUtc: string | null = null;
  private eventsRead = 0;
  private eventsApplied = 0;
  private eventsIgnored = 0;
  private eventsInvalid = 0;

  public constructor(private readonly requestedThroughSequence: number | null) {}

  public addIssue(issue: string): void {
    this.issues.push(issue);
  }

  public apply(event: StoredProviderEvidenceEvent): void {
    this.eventsRead += 1;
    this.eventCounts.set(event.eventType, (this.eventCounts.get(event.eventType) ?? 0) + 1);
    this.evidenceHasher.update(`${event.sequence}:${event.payloadHash}\n`);
    this.observeSequence(event.sequence);
    this.lastReceivedUtc = event.receivedUtc;

    switch (event.eventType) {
      case "accounts_snapshot":
        this.applySnapshot(event, isAccountInfo, (values) => {
          replaceMap(this.accounts, values, (value) => value.id);
        });
        return;
      case "contracts_snapshot":
        this.applySnapshot(event, isContractInfo, (values) => {
          replaceMap(this.contracts, values, (value) => value.id);
        });
        return;
      case "positions_snapshot":
        this.applySnapshot(event, isPositionInfo, (values) => {
          this.positions.clear();
          for (const value of values) {
            this.applyPosition(value);
          }
        });
        return;
      case "open_orders_snapshot":
        this.applySnapshot(event, isOrderInfo, (values) => {
          this.openOrders.clear();
          for (const value of values) {
            this.applyOrder(value);
          }
        });
        return;
      case "account":
        this.applySingle(event, isAccountInfo, (value) => this.accounts.set(value.id, value));
        return;
      case "position":
        this.applySingle(event, isPositionInfo, (value) => this.applyPosition(value));
        return;
      case "order":
      case "historical_order":
        this.applySingle(event, isOrderInfo, (value) => this.applyOrder(value));
        return;
      case "trade":
      case "historical_trade":
        this.applySingle(event, isTradeInfo, (value) => this.trades.set(value.id, value));
        return;
      case "quote":
        this.applySingle(event, isQuoteInfo, (value) => this.quotes.set(value.contractId, value));
        return;
      case "market_trade":
        this.applySingle(
          event,
          isMarketTradeInfo,
          (value) => this.marketTrades.set(value.contractId, value),
        );
        return;
      case "depth":
        this.applySingle(event, isMarketDepthInfo, (value) => {
          this.depth.set(`${value.contractId}|${value.type}|${value.price}`, value);
        });
        return;
      default:
        this.eventsIgnored += 1;
        if (event.source !== "projectx_lifecycle") {
          this.issues.push(`unsupported_event_type:${event.sequence}:${event.eventType}`);
        }
    }
  }

  public snapshot(truncated: boolean): ProjectXEvidenceReplaySnapshot {
    const accounts = sortedValues(this.accounts, (left, right) => left.id - right.id);
    const contracts = sortedValues(this.contracts, (left, right) => left.id.localeCompare(right.id));
    const positions = sortedValues(this.positions, (left, right) => left.id - right.id);
    const openOrders = sortedValues(this.openOrders, (left, right) => left.id - right.id);
    const orderHistory = sortedValues(this.orderHistory, (left, right) => left.id - right.id);
    const trades = sortedValues(this.trades, (left, right) => left.id - right.id);
    const quotes = sortedValues(
      this.quotes,
      (left, right) => left.contractId.localeCompare(right.contractId),
    );
    const latestMarketTrades = sortedValues(
      this.marketTrades,
      (left, right) => left.contractId.localeCompare(right.contractId),
    );
    const latestDepth = sortedValues(this.depth, (left, right) => (
      left.contractId.localeCompare(right.contractId)
      || left.type - right.type
      || left.price - right.price
    ));
    const stateHash = createHash("sha256").update(JSON.stringify({
      accounts,
      contracts,
      positions,
      openOrders,
      orderHistory,
      trades,
      quotes,
      latestMarketTrades,
      latestDepth,
    })).digest("hex");
    const evidenceComplete = this.eventsRead > 0
      && !truncated
      && this.eventsInvalid === 0
      && this.sequenceGaps.length === 0
      && this.firstSequence === 1;

    return {
      schema_version: "glitch.projectx.evidence_replay.v1",
      requested_through_sequence: this.requestedThroughSequence,
      through_sequence: this.throughSequence,
      first_sequence: this.firstSequence,
      last_received_utc: this.lastReceivedUtc,
      events_read: this.eventsRead,
      events_applied: this.eventsApplied,
      events_ignored: this.eventsIgnored,
      events_invalid: this.eventsInvalid,
      truncated,
      evidence_complete: evidenceComplete,
      sequence_gaps: [...this.sequenceGaps],
      event_counts: Object.fromEntries(
        [...this.eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      accounts,
      contracts,
      positions,
      open_orders: openOrders,
      order_history: orderHistory,
      trades,
      quotes,
      latest_market_trades: latestMarketTrades,
      latest_depth: latestDepth,
      issues: [...this.issues],
      state_hash: stateHash,
      evidence_hash: this.evidenceHasher.digest("hex"),
    };
  }

  private applyPosition(value: PositionInfo): void {
    if (value.type === 0 || value.size === 0) {
      this.positions.delete(value.id);
    } else {
      this.positions.set(value.id, value);
    }
  }

  private applyOrder(value: OrderInfo): void {
    this.orderHistory.set(value.id, value);
    if (TERMINAL_ORDER_STATUSES.has(value.status)) {
      this.openOrders.delete(value.id);
    } else {
      this.openOrders.set(value.id, value);
    }
  }

  private observeSequence(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) {
      this.eventsInvalid += 1;
      this.issues.push(`sequence_invalid:${sequence}`);
      return;
    }
    if (this.firstSequence === null) {
      this.firstSequence = sequence;
      if (sequence > 1) {
        this.sequenceGaps.push({
          after_sequence: 0,
          before_sequence: sequence,
          missing_count: sequence - 1,
        });
      }
    } else if (sequence === this.previousSequence) {
      this.eventsInvalid += 1;
      this.issues.push(`sequence_duplicate:${sequence}`);
    } else if (sequence < this.previousSequence) {
      this.eventsInvalid += 1;
      this.issues.push(`sequence_regression:${this.previousSequence}->${sequence}`);
    } else if (sequence > this.previousSequence + 1) {
      this.sequenceGaps.push({
        after_sequence: this.previousSequence,
        before_sequence: sequence,
        missing_count: sequence - this.previousSequence - 1,
      });
    }
    this.previousSequence = Math.max(this.previousSequence, sequence);
    this.throughSequence = Math.max(this.throughSequence, sequence);
  }

  private applySnapshot<T>(
    event: StoredProviderEvidenceEvent,
    guard: (value: unknown) => value is T,
    apply: (values: T[]) => void,
  ): void {
    if (!Array.isArray(event.normalizedPayload) || !event.normalizedPayload.every(guard)) {
      this.invalidPayload(event);
      return;
    }
    apply(event.normalizedPayload);
    this.eventsApplied += 1;
  }

  private applySingle<T>(
    event: StoredProviderEvidenceEvent,
    guard: (value: unknown) => value is T,
    apply: (value: T) => void,
  ): void {
    if (!guard(event.normalizedPayload)) {
      this.invalidPayload(event);
      return;
    }
    apply(event.normalizedPayload);
    this.eventsApplied += 1;
  }

  private invalidPayload(event: StoredProviderEvidenceEvent): void {
    this.eventsInvalid += 1;
    this.issues.push(`normalized_payload_invalid:${event.sequence}:${event.eventType}`);
  }
}

function fromRow(row: EvidenceRow): StoredProviderEvidenceEvent {
  return {
    sequence: Number(row.sequence),
    receivedUtc: row.received_utc,
    providerTimestampUtc: row.provider_timestamp_utc,
    source: row.source as StoredProviderEvidenceEvent["source"],
    eventType: row.event_type,
    generation: Number(row.generation),
    accountId: row.account_id === null ? null : Number(row.account_id),
    contractId: row.contract_id,
    providerEntityId: row.provider_entity_id,
    relatedProviderEntityId: row.related_provider_entity_id,
    payloadHash: row.payload_hash,
    rawPayload: JSON.parse(row.raw_payload_json) as unknown,
    normalizedPayload: JSON.parse(row.normalized_payload_json) as unknown,
  };
}

function replayDatabaseError(error: unknown): Error {
  const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return new Error(`provider_replay_database_error:${detail}`);
}

function replaceMap<K, V>(map: Map<K, V>, values: V[], key: (value: V) => K): void {
  map.clear();
  for (const value of values) {
    map.set(key(value), value);
  }
}

function sortedValues<K, V>(map: Map<K, V>, compare: (left: V, right: V) => number): V[] {
  return [...map.values()].sort(compare);
}

function isStrictlyAscending(values: number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! <= values[index - 1]!) {
      return false;
    }
  }
  return true;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  error: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(error);
  }
  return resolved;
}

function optionalInteger(
  value: number | undefined,
  error: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(error);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || isFiniteNumber(value);
}

function isAccountInfo(value: unknown): value is AccountInfo {
  return isRecord(value)
    && isInteger(value.id)
    && isString(value.name)
    && isFiniteNumber(value.balance)
    && typeof value.canTrade === "boolean"
    && typeof value.isVisible === "boolean"
    && (value.simulated === undefined || typeof value.simulated === "boolean");
}

function isContractInfo(value: unknown): value is ContractInfo {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && typeof value.description === "string"
    && isFiniteNumber(value.tickSize)
    && value.tickSize > 0
    && isFiniteNumber(value.tickValue)
    && value.tickValue > 0
    && typeof value.activeContract === "boolean"
    && isString(value.symbolId);
}

function isPositionInfo(value: unknown): value is PositionInfo {
  return isRecord(value)
    && isInteger(value.id)
    && isInteger(value.accountId)
    && isString(value.contractId)
    && isString(value.creationTimestamp)
    && isInteger(value.type)
    && [0, 1, 2].includes(value.type)
    && isFiniteNumber(value.size)
    && isFiniteNumber(value.averagePrice);
}

function isOrderInfo(value: unknown): value is OrderInfo {
  return isRecord(value)
    && isInteger(value.id)
    && isInteger(value.accountId)
    && isString(value.contractId)
    && isString(value.creationTimestamp)
    && isString(value.updateTimestamp)
    && isInteger(value.status)
    && isInteger(value.type)
    && isInteger(value.side)
    && isInteger(value.size)
    && value.size >= 0
    && isNullableFiniteNumber(value.limitPrice)
    && isNullableFiniteNumber(value.stopPrice)
    && (value.fillVolume === undefined || isFiniteNumber(value.fillVolume))
    && isNullableFiniteNumber(value.filledPrice)
    && (
      value.customTag === undefined
      || value.customTag === null
      || typeof value.customTag === "string"
    );
}

function isTradeInfo(value: unknown): value is TradeInfo {
  return isRecord(value)
    && isInteger(value.id)
    && isInteger(value.accountId)
    && isString(value.contractId)
    && isString(value.creationTimestamp)
    && isFiniteNumber(value.price)
    && isNullableFiniteNumber(value.profitAndLoss)
    && isNullableFiniteNumber(value.fees)
    && isInteger(value.side)
    && isInteger(value.size)
    && value.size >= 0
    && typeof value.voided === "boolean"
    && isInteger(value.orderId);
}

function isQuoteInfo(value: unknown): value is QuoteInfo {
  return isRecord(value)
    && isString(value.contractId)
    && isString(value.symbol)
    && (value.symbolName === undefined || typeof value.symbolName === "string")
    && isFiniteNumber(value.lastPrice)
    && isFiniteNumber(value.bestBid)
    && isFiniteNumber(value.bestAsk)
    && isFiniteNumber(value.open)
    && isFiniteNumber(value.high)
    && isFiniteNumber(value.low)
    && isFiniteNumber(value.volume)
    && isString(value.timestamp);
}

function isMarketTradeInfo(value: unknown): value is MarketTradeInfo {
  return isRecord(value)
    && isString(value.contractId)
    && isString(value.symbolId)
    && isFiniteNumber(value.price)
    && isString(value.timestamp)
    && isInteger(value.type)
    && [0, 1].includes(value.type)
    && isFiniteNumber(value.volume);
}

function isMarketDepthInfo(value: unknown): value is MarketDepthInfo {
  return isRecord(value)
    && isString(value.contractId)
    && isString(value.timestamp)
    && isInteger(value.type)
    && isFiniteNumber(value.price)
    && isFiniteNumber(value.volume)
    && isFiniteNumber(value.currentVolume);
}
