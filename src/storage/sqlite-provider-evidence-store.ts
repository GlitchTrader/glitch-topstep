import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ProviderEvidenceEvent,
  StoredProviderEvidenceEvent,
} from "../domain/provider-evidence.js";

interface EvidenceRow {
  sequence: number | bigint;
  recorded_utc: string;
  source: string;
  event_type: string;
  generation: number | bigint;
  account_id: number | bigint | null;
  contract_id: string | null;
  provider_entity_id: string | null;
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

  public append(event: ProviderEvidenceEvent): number {
    const result = this.database.prepare(`
      INSERT INTO provider_events (
        recorded_utc,
        source,
        event_type,
        generation,
        account_id,
        contract_id,
        provider_entity_id,
        raw_payload_json,
        normalized_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.recordedUtc,
      event.source,
      event.eventType,
      event.generation,
      event.accountId,
      event.contractId,
      event.providerEntityId,
      JSON.stringify(redactSecrets(event.rawPayload)),
      JSON.stringify(redactSecrets(event.normalizedPayload)),
    );
    return Number(result.lastInsertRowid);
  }

  public recent(limit = 100): StoredProviderEvidenceEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("provider_evidence_limit_invalid");
    }
    const rows = this.database.prepare(`
      SELECT
        sequence,
        recorded_utc,
        source,
        event_type,
        generation,
        account_id,
        contract_id,
        provider_entity_id,
        raw_payload_json,
        normalized_payload_json
      FROM provider_events
      ORDER BY sequence DESC
      LIMIT ?
    `).all(limit) as unknown as EvidenceRow[];
    return rows.reverse().map((row) => ({
      sequence: Number(row.sequence),
      recordedUtc: row.recorded_utc,
      source: row.source as StoredProviderEvidenceEvent["source"],
      eventType: row.event_type,
      generation: Number(row.generation),
      accountId: row.account_id === null ? null : Number(row.account_id),
      contractId: row.contract_id,
      providerEntityId: row.provider_entity_id,
      rawPayload: JSON.parse(row.raw_payload_json) as unknown,
      normalizedPayload: JSON.parse(row.normalized_payload_json) as unknown,
    }));
  }

  public count(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM provider_events
    `).get() as { count: number | bigint };
    return Number(row.count);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS provider_evidence_migrations (
        version INTEGER PRIMARY KEY,
        applied_utc TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provider_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_utc TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN (
          'projectx_rest', 'projectx_user_stream', 'projectx_market_stream'
        )),
        event_type TEXT NOT NULL,
        generation INTEGER NOT NULL,
        account_id INTEGER,
        contract_id TEXT,
        provider_entity_id TEXT,
        raw_payload_json TEXT NOT NULL,
        normalized_payload_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_provider_events_time
        ON provider_events(recorded_utc, sequence);
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
