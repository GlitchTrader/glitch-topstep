import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderHistorySyncStatus } from "../domain/provider-history.js";
import type {
  ProviderEvidenceEvent,
  ProviderEvidenceQuery,
  ProviderEvidenceStatus,
  StoredProviderEvidenceEvent,
} from "../domain/provider-evidence.js";

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

interface PreparedEvidence {
  event: ProviderEvidenceEvent;
  relatedProviderEntityId: string | null;
  rawPayload: unknown;
  normalizedPayload: unknown;
  rawPayloadJson: string;
  normalizedPayloadJson: string;
  payloadHash: string;
  contentHash: string;
}

export interface ProviderEvidenceStoreOptions {
  marketEventRetention?: number;
  marketPruneInterval?: number;
}

export interface AppendIfChangedResult {
  appended: boolean;
  event: StoredProviderEvidenceEvent | null;
}

const DEFAULT_MARKET_EVENT_RETENTION = 500_000;
const DEFAULT_MARKET_PRUNE_INTERVAL = 10_000;
const SECRET_KEY_FRAGMENTS = [
  "apikey",
  "authorization",
  "credential",
  "jwt",
  "password",
  "secret",
  "token",
];

export class SqliteProviderEvidenceStore {
  private readonly database: DatabaseSync;
  private readonly marketEventRetention: number;
  private readonly marketPruneInterval: number;
  private marketEventsSincePrune = 0;

  public constructor(path: string, options: ProviderEvidenceStoreOptions = {}) {
    this.marketEventRetention = integerOption(
      options.marketEventRetention,
      DEFAULT_MARKET_EVENT_RETENTION,
      "market_event_retention",
      1,
      50_000_000,
    );
    this.marketPruneInterval = integerOption(
      options.marketPruneInterval,
      DEFAULT_MARKET_PRUNE_INTERVAL,
      "market_prune_interval",
      1,
      1_000_000,
    );
    if (this.marketPruneInterval > this.marketEventRetention) {
      throw new Error("market_prune_interval_exceeds_retention");
    }

    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=NORMAL");
    this.database.exec("PRAGMA busy_timeout=5000");
    this.migrate();
    this.pruneMarketEvents();
  }

  public close(): void {
    this.database.close();
  }

  public append(event: ProviderEvidenceEvent): StoredProviderEvidenceEvent {
    const prepared = prepareEvidence(event);
    const stored = this.insertPrepared(prepared);
    this.maybePruneMarketEvent(event.source);
    return stored;
  }

  /** One transaction per batch: the queue writer amortizes commit cost over a burst. */
  public appendBatch(events: readonly ProviderEvidenceEvent[]): StoredProviderEvidenceEvent[] {
    if (events.length === 0) {
      return [];
    }
    const prepared = events.map(prepareEvidence);
    const stored = this.inTransaction(() => prepared.map((item) => this.insertPrepared(item)));
    for (const event of events) {
      this.maybePruneMarketEvent(event.source);
    }
    return stored;
  }

  public appendIfChanged(
    identityKey: string,
    event: ProviderEvidenceEvent,
  ): AppendIfChangedResult {
    if (identityKey.length < 1 || identityKey.length > 512) {
      throw new Error("provider_evidence_identity_key_invalid");
    }
    const prepared = prepareEvidence(event);
    return this.inTransaction(() => {
      const head = this.database.prepare(`
        SELECT content_hash, provider_timestamp_utc
        FROM provider_evidence_heads
        WHERE identity_key = ?
      `).get(identityKey) as {
        content_hash: string;
        provider_timestamp_utc: string | null;
      } | undefined;
      if (head?.content_hash === prepared.contentHash) {
        return { appended: false, event: null };
      }
      if (isStrictlyOlder(event.providerTimestampUtc, head?.provider_timestamp_utc ?? null)) {
        return { appended: false, event: null };
      }

      const stored = this.insertPrepared(prepared);
      this.database.prepare(`
        INSERT INTO provider_evidence_heads (
          identity_key,
          content_hash,
          provider_timestamp_utc,
          latest_sequence,
          updated_utc
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(identity_key) DO UPDATE SET
          content_hash = excluded.content_hash,
          provider_timestamp_utc = excluded.provider_timestamp_utc,
          latest_sequence = excluded.latest_sequence,
          updated_utc = excluded.updated_utc
      `).run(
        identityKey,
        prepared.contentHash,
        event.providerTimestampUtc,
        stored.sequence,
        event.receivedUtc,
      );
      return { appended: true, event: stored };
    });
  }

  public recent(limit = 100): StoredProviderEvidenceEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("provider_evidence_limit_invalid");
    }
    const rows = this.database.prepare(`
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
      ORDER BY sequence DESC
      LIMIT ?
    `).all(limit) as unknown as EvidenceRow[];
    return rows.reverse().map((row) => this.fromRow(row));
  }

  public query(query: ProviderEvidenceQuery): StoredProviderEvidenceEvent[] {
    const limit = query.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("provider_evidence_query_limit_invalid");
    }
    if (
      query.afterSequence !== undefined
      && (!Number.isInteger(query.afterSequence) || query.afterSequence < 0)
    ) {
      throw new Error("provider_evidence_after_sequence_invalid");
    }

    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (clause: string, value: string | number | undefined): void => {
      if (value === undefined) {
        return;
      }
      clauses.push(clause);
      parameters.push(value);
    };
    add("source = ?", query.source);
    add("event_type = ?", query.eventType);
    add("account_id = ?", query.accountId);
    add("contract_id = ?", query.contractId);
    add("provider_entity_id = ?", query.providerEntityId);
    add("related_provider_entity_id = ?", query.relatedProviderEntityId);
    add("sequence > ?", query.afterSequence);
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;

    const rows = this.database.prepare(`
      SELECT * FROM (
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
        ${where}
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(...parameters, limit) as unknown as EvidenceRow[];
    return rows.map((row) => this.fromRow(row));
  }

  public historySyncStatus(syncKey: string): ProviderHistorySyncStatus {
    const row = this.database.prepare(`
      SELECT
        sync_key,
        cursor_utc,
        last_attempt_utc,
        last_succeeded_utc,
        last_window_start_utc,
        last_window_end_utc,
        last_error,
        last_orders_seen,
        last_trades_seen,
        last_events_appended
      FROM provider_history_sync
      WHERE sync_key = ?
    `).get(syncKey) as {
      sync_key: string;
      cursor_utc: string | null;
      last_attempt_utc: string | null;
      last_succeeded_utc: string | null;
      last_window_start_utc: string | null;
      last_window_end_utc: string | null;
      last_error: string | null;
      last_orders_seen: number | bigint;
      last_trades_seen: number | bigint;
      last_events_appended: number | bigint;
    } | undefined;
    if (!row) {
      return {
        syncKey,
        cursorUtc: null,
        lastAttemptUtc: null,
        lastSucceededUtc: null,
        lastWindowStartUtc: null,
        lastWindowEndUtc: null,
        lastError: null,
        lastOrdersSeen: 0,
        lastTradesSeen: 0,
        lastEventsAppended: 0,
      };
    }
    return {
      syncKey: row.sync_key,
      cursorUtc: row.cursor_utc,
      lastAttemptUtc: row.last_attempt_utc,
      lastSucceededUtc: row.last_succeeded_utc,
      lastWindowStartUtc: row.last_window_start_utc,
      lastWindowEndUtc: row.last_window_end_utc,
      lastError: row.last_error,
      lastOrdersSeen: Number(row.last_orders_seen),
      lastTradesSeen: Number(row.last_trades_seen),
      lastEventsAppended: Number(row.last_events_appended),
    };
  }

  public recordHistorySyncAttempt(
    syncKey: string,
    attemptedUtc: string,
    windowStartUtc: string,
    windowEndUtc: string,
  ): void {
    this.database.prepare(`
      INSERT INTO provider_history_sync (
        sync_key,
        cursor_utc,
        last_attempt_utc,
        last_succeeded_utc,
        last_window_start_utc,
        last_window_end_utc,
        last_error,
        last_orders_seen,
        last_trades_seen,
        last_events_appended
      ) VALUES (?, NULL, ?, NULL, ?, ?, NULL, 0, 0, 0)
      ON CONFLICT(sync_key) DO UPDATE SET
        last_attempt_utc = excluded.last_attempt_utc,
        last_window_start_utc = excluded.last_window_start_utc,
        last_window_end_utc = excluded.last_window_end_utc,
        last_error = NULL
    `).run(syncKey, attemptedUtc, windowStartUtc, windowEndUtc);
  }

  public recordHistorySyncSuccess(
    syncKey: string,
    cursorUtc: string,
    succeededUtc: string,
    windowStartUtc: string,
    windowEndUtc: string,
    ordersSeen: number,
    tradesSeen: number,
    eventsAppended: number,
  ): void {
    this.database.prepare(`
      INSERT INTO provider_history_sync (
        sync_key,
        cursor_utc,
        last_attempt_utc,
        last_succeeded_utc,
        last_window_start_utc,
        last_window_end_utc,
        last_error,
        last_orders_seen,
        last_trades_seen,
        last_events_appended
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(sync_key) DO UPDATE SET
        cursor_utc = excluded.cursor_utc,
        last_attempt_utc = excluded.last_attempt_utc,
        last_succeeded_utc = excluded.last_succeeded_utc,
        last_window_start_utc = excluded.last_window_start_utc,
        last_window_end_utc = excluded.last_window_end_utc,
        last_error = NULL,
        last_orders_seen = excluded.last_orders_seen,
        last_trades_seen = excluded.last_trades_seen,
        last_events_appended = excluded.last_events_appended
    `).run(
      syncKey,
      cursorUtc,
      succeededUtc,
      succeededUtc,
      windowStartUtc,
      windowEndUtc,
      ordersSeen,
      tradesSeen,
      eventsAppended,
    );
  }

  public recordHistorySyncFailure(
    syncKey: string,
    failedUtc: string,
    windowStartUtc: string,
    windowEndUtc: string,
    error: string,
  ): void {
    this.database.prepare(`
      INSERT INTO provider_history_sync (
        sync_key,
        cursor_utc,
        last_attempt_utc,
        last_succeeded_utc,
        last_window_start_utc,
        last_window_end_utc,
        last_error,
        last_orders_seen,
        last_trades_seen,
        last_events_appended
      ) VALUES (?, NULL, ?, NULL, ?, ?, ?, 0, 0, 0)
      ON CONFLICT(sync_key) DO UPDATE SET
        last_attempt_utc = excluded.last_attempt_utc,
        last_window_start_utc = excluded.last_window_start_utc,
        last_window_end_utc = excluded.last_window_end_utc,
        last_error = excluded.last_error
    `).run(syncKey, failedUtc, windowStartUtc, windowEndUtc, error);
  }

  public status(): ProviderEvidenceStatus {
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS event_count,
        SUM(CASE WHEN source = 'projectx_market_stream' THEN 1 ELSE 0 END) AS market_event_count,
        MIN(sequence) AS earliest_sequence,
        MAX(sequence) AS latest_sequence,
        MAX(received_utc) AS latest_received_utc
      FROM provider_events
    `).get() as {
      event_count: number | bigint;
      market_event_count: number | bigint | null;
      earliest_sequence: number | bigint | null;
      latest_sequence: number | bigint | null;
      latest_received_utc: string | null;
    };
    return {
      eventCount: Number(row.event_count),
      marketEventCount: Number(row.market_event_count ?? 0),
      earliestSequence: row.earliest_sequence === null ? null : Number(row.earliest_sequence),
      latestSequence: row.latest_sequence === null ? null : Number(row.latest_sequence),
      latestReceivedUtc: row.latest_received_utc,
      marketEventRetention: this.marketEventRetention,
      marketPruneInterval: this.marketPruneInterval,
      maximumMarketEventsBetweenPrunes:
        this.marketEventRetention + this.marketPruneInterval - 1,
    };
  }

  private insertPrepared(prepared: PreparedEvidence): StoredProviderEvidenceEvent {
    const event = prepared.event;
    const result = this.database.prepare(`
      INSERT INTO provider_events (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.receivedUtc,
      event.providerTimestampUtc,
      event.source,
      event.eventType,
      event.generation,
      event.accountId,
      event.contractId,
      event.providerEntityId,
      prepared.relatedProviderEntityId,
      prepared.payloadHash,
      prepared.rawPayloadJson,
      prepared.normalizedPayloadJson,
    );
    return {
      ...event,
      sequence: Number(result.lastInsertRowid),
      payloadHash: prepared.payloadHash,
      relatedProviderEntityId: prepared.relatedProviderEntityId,
      rawPayload: prepared.rawPayload,
      normalizedPayload: prepared.normalizedPayload,
    };
  }

  private maybePruneMarketEvent(source: string): void {
    if (source !== "projectx_market_stream") {
      return;
    }
    this.marketEventsSincePrune += 1;
    if (this.marketEventsSincePrune >= this.marketPruneInterval) {
      this.pruneMarketEvents();
      this.marketEventsSincePrune = 0;
    }
  }

  private pruneMarketEvents(): void {
    this.database.prepare(`
      DELETE FROM provider_events
      WHERE source = 'projectx_market_stream'
        AND sequence <= COALESCE((
          SELECT sequence
          FROM provider_events
          WHERE source = 'projectx_market_stream'
          ORDER BY sequence DESC
          LIMIT 1 OFFSET ?
        ), 0)
    `).run(this.marketEventRetention);
  }

  private fromRow(row: EvidenceRow): StoredProviderEvidenceEvent {
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

  private migrate(): void {
    this.inTransaction(() => {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS provider_evidence_migrations (
        version INTEGER PRIMARY KEY,
        applied_utc TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provider_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        received_utc TEXT NOT NULL,
        provider_timestamp_utc TEXT,
        source TEXT NOT NULL CHECK(source IN (
          'projectx_rest',
          'projectx_user_stream',
          'projectx_market_stream',
          'projectx_lifecycle'
        )),
        event_type TEXT NOT NULL,
        generation INTEGER NOT NULL,
        account_id INTEGER,
        contract_id TEXT,
        provider_entity_id TEXT,
        related_provider_entity_id TEXT,
        payload_hash TEXT NOT NULL,
        raw_payload_json TEXT NOT NULL,
        normalized_payload_json TEXT NOT NULL
      ) STRICT;
      `);

      const columns = this.database.prepare(`PRAGMA table_info(provider_events)`).all() as unknown as Array<{
      name: string;
      }>;
      if (!columns.some((column) => column.name === "related_provider_entity_id")) {
        this.database.exec(`ALTER TABLE provider_events ADD COLUMN related_provider_entity_id TEXT`);
      }

      this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_events_time
        ON provider_events(received_utc, sequence);
      CREATE INDEX IF NOT EXISTS idx_provider_events_entity
        ON provider_events(event_type, account_id, contract_id, provider_entity_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_provider_events_relation
        ON provider_events(event_type, account_id, contract_id, related_provider_entity_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_provider_events_source_sequence
        ON provider_events(source, sequence);

      CREATE TABLE IF NOT EXISTS provider_evidence_heads (
        identity_key TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        provider_timestamp_utc TEXT,
        latest_sequence INTEGER NOT NULL,
        updated_utc TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provider_history_sync (
        sync_key TEXT PRIMARY KEY,
        cursor_utc TEXT,
        last_attempt_utc TEXT,
        last_succeeded_utc TEXT,
        last_window_start_utc TEXT,
        last_window_end_utc TEXT,
        last_error TEXT,
        last_orders_seen INTEGER NOT NULL DEFAULT 0,
        last_trades_seen INTEGER NOT NULL DEFAULT 0,
        last_events_appended INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      INSERT OR IGNORE INTO provider_evidence_migrations(version, applied_utc)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);

      const headColumns = this.database.prepare(`PRAGMA table_info(provider_evidence_heads)`).all() as unknown as Array<{
      name: string;
      }>;
      if (!headColumns.some((column) => column.name === "provider_timestamp_utc")) {
        this.database.exec(`ALTER TABLE provider_evidence_heads ADD COLUMN provider_timestamp_utc TEXT`);
      }

      this.backfillTradeRelations();
      this.database.exec(`
      INSERT OR IGNORE INTO provider_evidence_migrations(version, applied_utc)
      VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT OR IGNORE INTO provider_evidence_migrations(version, applied_utc)
      VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
    });
  }

  private backfillTradeRelations(): void {
    const rows = this.database.prepare(`
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
      WHERE source = 'projectx_user_stream'
        AND event_type = 'trade'
        AND related_provider_entity_id IS NULL
      ORDER BY sequence ASC
    `).all() as unknown as EvidenceRow[];

    const update = this.database.prepare(`
      UPDATE provider_events
      SET related_provider_entity_id = ?, payload_hash = ?
      WHERE sequence = ?
    `);
    for (const row of rows) {
      const normalizedPayload = JSON.parse(row.normalized_payload_json) as unknown;
      const orderId = relatedOrderId(normalizedPayload);
      if (orderId === null) {
        continue;
      }
      const rawPayload = JSON.parse(row.raw_payload_json) as unknown;
      const relatedProviderEntityId = String(orderId);
      const payloadHash = evidencePayloadHash({
        receivedUtc: row.received_utc,
        providerTimestampUtc: row.provider_timestamp_utc,
        source: row.source,
        eventType: row.event_type,
        generation: Number(row.generation),
        accountId: row.account_id === null ? null : Number(row.account_id),
        contractId: row.contract_id,
        providerEntityId: row.provider_entity_id,
        relatedProviderEntityId,
        rawPayload,
        normalizedPayload,
      });
      update.run(relatedProviderEntityId, payloadHash, Number(row.sequence));
    }
  }

  private inTransaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    output[key] = isSecretKey(key) ? "[REDACTED]" : redactSecrets(item);
  }
  return output;
}

function prepareEvidence(event: ProviderEvidenceEvent): PreparedEvidence {
  const rawPayload = redactSecrets(event.rawPayload ?? null);
  const normalizedPayload = redactSecrets(event.normalizedPayload ?? null);
  const relatedProviderEntityId = event.relatedProviderEntityId ?? null;
  const rawPayloadJson = safeJson(rawPayload);
  const normalizedPayloadJson = safeJson(normalizedPayload);
  const payloadHash = evidencePayloadHash({
    ...event,
    relatedProviderEntityId,
    rawPayload,
    normalizedPayload,
  });
  const contentHash = createHash("sha256")
    .update(stableJson({
      source: event.source,
      eventType: event.eventType,
      accountId: event.accountId,
      contractId: event.contractId,
      providerEntityId: event.providerEntityId,
      relatedProviderEntityId,
      providerTimestampUtc: event.providerTimestampUtc,
      rawPayload,
      normalizedPayload,
    }))
    .digest("hex");
  return {
    event,
    relatedProviderEntityId,
    rawPayload,
    normalizedPayload,
    rawPayloadJson,
    normalizedPayloadJson,
    payloadHash,
    contentHash,
  };
}

function evidencePayloadHash(value: {
  receivedUtc: string;
  providerTimestampUtc: string | null;
  source: string;
  eventType: string;
  generation: number;
  accountId: number | null;
  contractId: string | null;
  providerEntityId: string | null;
  relatedProviderEntityId: string | null;
  rawPayload: unknown;
  normalizedPayload: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value) ?? null) ?? "null";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stableValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function relatedOrderId(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const orderId = (value as Record<string, unknown>).orderId;
  return typeof orderId === "number" && Number.isInteger(orderId) ? orderId : null;
}

function isStrictlyOlder(candidate: string | null, current: string | null): boolean {
  if (candidate === null || current === null) {
    return false;
  }
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current);
  return Number.isFinite(candidateMs) && Number.isFinite(currentMs) && candidateMs < currentMs;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`provider_evidence_${name}_invalid`);
  }
  return resolved;
}
