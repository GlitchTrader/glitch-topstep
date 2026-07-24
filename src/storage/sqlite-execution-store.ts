import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionMutationState,
  ExecutionOperation,
  ExecutionRecoveryStatus,
  StoredExecutionMutation,
} from "../domain/execution-state.js";
import type { TradeIntent } from "../domain/models.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";

interface SqlRow {
  [key: string]: string | number | bigint | Uint8Array | null;
}

export class SqliteExecutionStore {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec("PRAGMA foreign_keys=ON");
    this.database.exec("PRAGMA busy_timeout=5000");
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  public recordIssuedPacket(packet: DirectDecisionPacket): void {
    this.database.prepare(`
      INSERT INTO issued_packets (
        snapshot_hash, packet_id, issued_utc, expires_utc, invalidated_utc, payload_json
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(snapshot_hash) DO UPDATE SET
        packet_id = excluded.packet_id,
        issued_utc = excluded.issued_utc,
        expires_utc = excluded.expires_utc,
        invalidated_utc = NULL,
        payload_json = excluded.payload_json
    `).run(
      packet.market.snapshot_hash,
      packet.packet_id,
      packet.created_utc,
      packet.expires_utc,
      JSON.stringify(packet),
    );
  }

  public resolveIssuedPacket(
    snapshotHash: string,
    nowUtc: string,
  ): DirectDecisionPacket | null {
    const row = this.database.prepare(`
      SELECT payload_json
      FROM issued_packets
      WHERE snapshot_hash = ?
        AND invalidated_utc IS NULL
        AND expires_utc >= ?
    `).get(snapshotHash, nowUtc) as SqlRow | undefined;
    return row ? this.parseJson<DirectDecisionPacket>(row.payload_json, "issued_packet") : null;
  }

  public invalidateIssuedPackets(atUtc: string): void {
    this.database.prepare(`
      UPDATE issued_packets
      SET invalidated_utc = ?
      WHERE invalidated_utc IS NULL
    `).run(atUtc);
  }

  public registerIntent(intent: TradeIntent, receivedUtc: string): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO intents (
        intent_id, snapshot_hash, received_utc, account_alias, instrument, action, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      intent.intentId,
      intent.snapshotHash,
      receivedUtc,
      intent.account,
      intent.instrument,
      intent.action,
      JSON.stringify(intent),
    );
    return Number(result.changes) === 1;
  }

  public recordReceipt(receipt: Record<string, unknown>): void {
    const receiptId = this.requiredString(receipt.receipt_id, "receipt_id");
    const intentId = typeof receipt.intent_id === "string" ? receipt.intent_id : null;
    const recordedUtc = this.requiredString(receipt.recorded_utc, "recorded_utc");
    const status = this.requiredString(receipt.status, "status");
    const code = this.requiredString(receipt.code, "code");
    this.database.prepare(`
      INSERT INTO execution_receipts (
        receipt_id, intent_id, recorded_utc, status, code, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_id) DO UPDATE SET
        receipt_id = excluded.receipt_id,
        recorded_utc = excluded.recorded_utc,
        status = excluded.status,
        code = excluded.code,
        payload_json = excluded.payload_json
    `).run(
      receiptId,
      intentId,
      recordedUtc,
      status,
      code,
      JSON.stringify(receipt),
    );
  }

  public receiptForIntent<T>(intentId: string): T | null {
    const row = this.database.prepare(`
      SELECT payload_json
      FROM execution_receipts
      WHERE intent_id = ?
    `).get(intentId) as SqlRow | undefined;
    return row ? this.parseJson<T>(row.payload_json, "execution_receipt") : null;
  }

  public prepareMutation(
    intentId: string,
    operation: ExecutionOperation,
    request: Record<string, unknown>,
    customTag: string | null,
    createdUtc: string,
  ): void {
    this.database.prepare(`
      INSERT INTO execution_outbox (
        intent_id, operation, state, custom_tag, request_json, created_utc,
        submitting_utc, resolved_utc, provider_order_id, last_error
      ) VALUES (?, ?, 'prepared', ?, ?, ?, NULL, NULL, NULL, NULL)
    `).run(
      intentId,
      operation,
      customTag,
      JSON.stringify(request),
      createdUtc,
    );
  }

  public markMutationSubmitting(intentId: string, atUtc: string): void {
    this.transitionMutation(intentId, ["prepared"], "submitting", {
      submittingUtc: atUtc,
      resolvedUtc: null,
      providerOrderId: null,
      lastError: null,
    });
  }

  public markMutationSubmitted(intentId: string, orderId: number | null, atUtc: string): void {
    this.transitionMutation(intentId, ["submitting", "ambiguous"], "submitted", {
      resolvedUtc: atUtc,
      providerOrderId: orderId,
      lastError: null,
    });
  }

  public markMutationConfirmedNotSubmitted(intentId: string, atUtc: string): void {
    this.transitionMutation(intentId, ["prepared"], "confirmed_not_submitted", {
      resolvedUtc: atUtc,
      providerOrderId: null,
      lastError: null,
    });
  }

  public markMutationRejected(intentId: string, error: string, atUtc: string): void {
    this.transitionMutation(intentId, ["submitting"], "rejected", {
      resolvedUtc: atUtc,
      providerOrderId: null,
      lastError: error,
    });
  }

  public markMutationAmbiguous(intentId: string, error: string, atUtc: string): void {
    this.transitionMutation(intentId, ["submitting", "ambiguous"], "ambiguous", {
      resolvedUtc: null,
      providerOrderId: null,
      lastError: error,
    });
  }

  public unresolvedMutations(): StoredExecutionMutation[] {
    const rows = this.database.prepare(`
      SELECT
        intent_id, operation, state, custom_tag, request_json, created_utc,
        submitting_utc, resolved_utc, provider_order_id, last_error
      FROM execution_outbox
      WHERE state IN ('prepared', 'submitting', 'ambiguous')
      ORDER BY created_utc ASC
    `).all() as SqlRow[];
    return rows.map((row) => this.mutationFromRow(row));
  }

  public recoveryStatus(): ExecutionRecoveryStatus {
    const counts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN state IN ('prepared', 'submitting', 'ambiguous') THEN 1 ELSE 0 END) AS unresolved,
        SUM(CASE WHEN state IN ('submitting', 'ambiguous') THEN 1 ELSE 0 END) AS ambiguous
      FROM execution_outbox
    `).get() as SqlRow;
    const lastRecoveryUtc = this.meta("last_recovery_utc");
    const lastRecoveryError = this.meta("last_recovery_error");
    const unresolvedMutations = Number(counts.unresolved ?? 0);
    const ambiguousMutations = Number(counts.ambiguous ?? 0);
    return {
      blockingAmbiguity: ambiguousMutations > 0,
      unresolvedMutations,
      ambiguousMutations,
      lastRecoveryUtc,
      lastRecoveryError,
    };
  }

  public recordRecoveryResult(atUtc: string, error: string | null): void {
    this.setMeta("last_recovery_utc", atUtc);
    this.setMeta("last_recovery_error", error);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_utc TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS issued_packets (
        snapshot_hash TEXT PRIMARY KEY,
        packet_id TEXT NOT NULL,
        issued_utc TEXT NOT NULL,
        expires_utc TEXT NOT NULL,
        invalidated_utc TEXT,
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS intents (
        intent_id TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL,
        received_utc TEXT NOT NULL,
        account_alias TEXT NOT NULL,
        instrument TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS execution_outbox (
        intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
        operation TEXT NOT NULL CHECK(operation IN ('place_order', 'close_position')),
        state TEXT NOT NULL CHECK(state IN (
          'prepared', 'submitting', 'submitted', 'confirmed_not_submitted', 'rejected', 'ambiguous'
        )),
        custom_tag TEXT UNIQUE,
        request_json TEXT NOT NULL,
        created_utc TEXT NOT NULL,
        submitting_utc TEXT,
        resolved_utc TEXT,
        provider_order_id INTEGER,
        last_error TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS execution_receipts (
        receipt_id TEXT PRIMARY KEY,
        intent_id TEXT UNIQUE REFERENCES intents(intent_id),
        recorded_utc TEXT NOT NULL,
        status TEXT NOT NULL,
        code TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_issued_packets_expiry
        ON issued_packets(expires_utc, invalidated_utc);
      CREATE INDEX IF NOT EXISTS idx_execution_outbox_state
        ON execution_outbox(state, created_utc);

      INSERT OR IGNORE INTO schema_migrations(version, applied_utc)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  }

  private transitionMutation(
    intentId: string,
    allowedStates: ExecutionMutationState[],
    nextState: ExecutionMutationState,
    values: {
      submittingUtc?: string | null;
      resolvedUtc?: string | null;
      providerOrderId?: number | null;
      lastError?: string | null;
    },
  ): void {
    const current = this.database.prepare(`
      SELECT state, submitting_utc, resolved_utc, provider_order_id, last_error
      FROM execution_outbox
      WHERE intent_id = ?
    `).get(intentId) as SqlRow | undefined;
    if (!current) {
      throw new Error(`execution_mutation_not_found:${intentId}`);
    }
    const state = String(current.state) as ExecutionMutationState;
    if (!allowedStates.includes(state)) {
      throw new Error(`execution_mutation_transition_invalid:${state}->${nextState}`);
    }
    this.database.prepare(`
      UPDATE execution_outbox
      SET state = ?, submitting_utc = ?, resolved_utc = ?, provider_order_id = ?, last_error = ?
      WHERE intent_id = ?
    `).run(
      nextState,
      values.submittingUtc === undefined ? current.submitting_utc : values.submittingUtc,
      values.resolvedUtc === undefined ? current.resolved_utc : values.resolvedUtc,
      values.providerOrderId === undefined ? current.provider_order_id : values.providerOrderId,
      values.lastError === undefined ? current.last_error : values.lastError,
      intentId,
    );
  }

  private mutationFromRow(row: SqlRow): StoredExecutionMutation {
    return {
      intentId: String(row.intent_id),
      operation: String(row.operation) as ExecutionOperation,
      state: String(row.state) as ExecutionMutationState,
      customTag: row.custom_tag === null ? null : String(row.custom_tag),
      request: this.parseJson<Record<string, unknown>>(row.request_json, "execution_request"),
      createdUtc: String(row.created_utc),
      submittingUtc: row.submitting_utc === null ? null : String(row.submitting_utc),
      resolvedUtc: row.resolved_utc === null ? null : String(row.resolved_utc),
      providerOrderId: row.provider_order_id === null ? null : Number(row.provider_order_id),
      lastError: row.last_error === null ? null : String(row.last_error),
    };
  }

  private meta(key: string): string | null {
    const row = this.database.prepare(`
      SELECT value FROM runtime_meta WHERE key = ?
    `).get(key) as SqlRow | undefined;
    return row?.value === null || row?.value === undefined ? null : String(row.value);
  }

  private setMeta(key: string, value: string | null): void {
    this.database.prepare(`
      INSERT INTO runtime_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private parseJson<T>(value: unknown, name: string): T {
    if (typeof value !== "string") {
      throw new Error(`${name}_json_missing`);
    }
    return JSON.parse(value) as T;
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name}_invalid`);
    }
    return value;
  }
}
