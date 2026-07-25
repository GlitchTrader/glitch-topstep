import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ProviderEvidenceEvent,
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
  payload_hash: string;
  raw_payload_json: string;
  normalized_payload_json: string;
}

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

  public constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec("PRAGMA busy_timeout=5000");
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  public append(event: ProviderEvidenceEvent): StoredProviderEvidenceEvent {
    const rawPayload = redactSecrets(event.rawPayload);
    const normalizedPayload = redactSecrets(event.normalizedPayload);
    const rawPayloadJson = safeJson(rawPayload);
    const normalizedPayloadJson = safeJson(normalizedPayload);
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({
        receivedUtc: event.receivedUtc,
        providerTimestampUtc: event.providerTimestampUtc,
        source: event.source,
        eventType: event.eventType,
        generation: event.generation,
        accountId: event.accountId,
        contractId: event.contractId,
        providerEntityId: event.providerEntityId,
        rawPayload,
        normalizedPayload,
      }))
      .digest("hex");

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
        payload_hash,
        raw_payload_json,
        normalized_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.receivedUtc,
      event.providerTimestampUtc,
      event.source,
      event.eventType,
      event.generation,
      event.accountId,
      event.contractId,
      event.providerEntityId,
      payloadHash,
      rawPayloadJson,
      normalizedPayloadJson,
    );

    return {
      ...event,
      sequence: Number(result.lastInsertRowid),
      payloadHash,
      rawPayload,
      normalizedPayload,
    };
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
        payload_hash,
        raw_payload_json,
        normalized_payload_json
      FROM provider_events
      ORDER BY sequence DESC
      LIMIT ?
    `).all(limit) as unknown as EvidenceRow[];
    return rows.reverse().map((row) => this.fromRow(row));
  }

  public status(): ProviderEvidenceStatus {
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS event_count,
        MAX(sequence) AS latest_sequence,
        MAX(received_utc) AS latest_received_utc
      FROM provider_events
    `).get() as {
      event_count: number | bigint;
      latest_sequence: number | bigint | null;
      latest_received_utc: string | null;
    };
    return {
      eventCount: Number(row.event_count),
      latestSequence: row.latest_sequence === null ? null : Number(row.latest_sequence),
      latestReceivedUtc: row.latest_received_utc,
    };
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
      payloadHash: row.payload_hash,
      rawPayload: JSON.parse(row.raw_payload_json) as unknown,
      normalizedPayload: JSON.parse(row.normalized_payload_json) as unknown,
    };
  }

  private migrate(): void {
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
        payload_hash TEXT NOT NULL,
        raw_payload_json TEXT NOT NULL,
        normalized_payload_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_provider_events_time
        ON provider_events(received_utc, sequence);
      CREATE INDEX IF NOT EXISTS idx_provider_events_entity
        ON provider_events(event_type, account_id, contract_id, provider_entity_id, sequence);

      INSERT OR IGNORE INTO provider_evidence_migrations(version, applied_utc)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
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
    if (isSecretKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redactSecrets(item);
  }
  return output;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}
