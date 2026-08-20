import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ExecutionMutationState,
  ExecutionOperation,
  ExecutionRecoveryStatus,
  StoredExecutionMutation,
  StoredIntentWithoutExecution,
} from "../domain/execution-state.js";
import { computeIntentBodyHash } from "../domain/intent-body-hash.js";
import type { TradeIntent } from "../domain/models.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import { queryExitTargetedIntentIds } from "../ownership/tranches.js";
import { lifecycleFactId, type LifecycleDiagnostics } from "../execution/lifecycle-facts.js";
import {
  transitionProtectedReduction,
  type ProtectedReductionRecord,
  type ProtectedReductionState,
} from "../execution/protected-reduction-saga.js";

export interface ExecutionFactWrite {
  sequence: number;
  factId: string;
  revision: number;
  /** False when the identical fact content was already recorded. */
  recorded: boolean;
}

export type IntentRegistrationResult =
  | { status: "claimed" }
  | { status: "duplicate" }
  | { status: "conflict" };

interface SqlRow {
  [key: string]: string | number | bigint | Uint8Array | null;
  state: string;
  submitting_utc: string | null;
  resolved_utc: string | null;
  provider_order_id: number | bigint | null;
  last_error: string | null;
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
        packet_id = CASE WHEN issued_packets.expires_utc < excluded.issued_utc OR issued_packets.invalidated_utc IS NOT NULL THEN excluded.packet_id ELSE issued_packets.packet_id END,
        issued_utc = CASE WHEN issued_packets.expires_utc < excluded.issued_utc OR issued_packets.invalidated_utc IS NOT NULL THEN excluded.issued_utc ELSE issued_packets.issued_utc END,
        expires_utc = CASE WHEN issued_packets.expires_utc < excluded.issued_utc OR issued_packets.invalidated_utc IS NOT NULL THEN excluded.expires_utc ELSE issued_packets.expires_utc END,
        invalidated_utc = CASE WHEN issued_packets.expires_utc < excluded.issued_utc OR issued_packets.invalidated_utc IS NOT NULL THEN NULL ELSE issued_packets.invalidated_utc END,
        payload_json = CASE WHEN issued_packets.expires_utc < excluded.issued_utc OR issued_packets.invalidated_utc IS NOT NULL THEN excluded.payload_json ELSE issued_packets.payload_json END
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

  public registerIntent(intent: TradeIntent, receivedUtc: string): IntentRegistrationResult {
    const bodyHash = computeIntentBodyHash(intent);
    return this.inTransaction(() => {
      const existing = this.database.prepare(`
        SELECT body_hash
        FROM intents
        WHERE intent_id = ?
      `).get(intent.intentId) as SqlRow | undefined;
      if (existing) {
        const storedHash = String(existing.body_hash);
        if (storedHash === "" || storedHash.startsWith("legacy:")) {
          // v1 databases did not persist the semantic body hash. The first
          // replay after upgrade establishes it atomically, preserving the
          // original intent row instead of falsely reporting a conflict.
          this.database.prepare(`
            UPDATE intents SET body_hash = ? WHERE intent_id = ?
          `).run(bodyHash, intent.intentId);
          return { status: "duplicate" as const };
        }
        return storedHash === bodyHash
          ? { status: "duplicate" as const }
          : { status: "conflict" as const };
      }
      this.database.prepare(`
        INSERT INTO intents (
          intent_id, body_hash, snapshot_hash, received_utc, account_alias, instrument, action, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intent.intentId,
        bodyHash,
        intent.snapshotHash,
        receivedUtc,
        intent.account,
        intent.instrument,
        intent.action,
        JSON.stringify(intent),
      );
      return { status: "claimed" as const };
    });
  }

  public registeredIntentPayload(intentId: string): TradeIntent | null {
    const row = this.database.prepare(`
      SELECT payload_json
      FROM intents
      WHERE intent_id = ?
    `).get(intentId) as SqlRow | undefined;
    if (!row) {
      return null;
    }
    return this.parseJson<TradeIntent>(String(row.payload_json), "intent");
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

  public decisionLinkForIntent(intentId: string): {
    snapshot_hash: string;
    packet_id: string | null;
  } | null {
    const intent = this.database.prepare(`
      SELECT snapshot_hash
      FROM intents
      WHERE intent_id = ?
    `).get(intentId) as SqlRow | undefined;
    if (!intent) {
      return null;
    }
    const snapshotHash = String(intent.snapshot_hash);
    const packet = this.database.prepare(`
      SELECT packet_id
      FROM issued_packets
      WHERE snapshot_hash = ?
    `).get(snapshotHash) as SqlRow | undefined;
    return {
      snapshot_hash: snapshotHash,
      packet_id: packet ? String(packet.packet_id) : null,
    };
  }

  public pendingReceiptIntentIds(): string[] {
    const rows = this.database.prepare(`
      SELECT intent_id
      FROM execution_receipts
      WHERE json_extract(payload_json, '$.status') = 'pending'
      ORDER BY recorded_utc ASC
    `).all() as SqlRow[];
    return rows.map((row) => String(row.intent_id));
  }

  /** Earliest fill observation among pending entry receipts, for bracket verification timeout. */
  public earliestPendingEntryFillObservedUtc(): string | null {
    let earliest: string | null = null;
    for (const intentId of this.pendingReceiptIntentIds()) {
      const mutation = this.mutationForIntent(intentId);
      if (mutation?.operation !== "place_order") {
        continue;
      }
      const receipt = this.receiptForIntent<{ fill_observed_utc?: string }>(intentId);
      const candidate = receipt?.fill_observed_utc ?? null;
      if (!candidate) {
        continue;
      }
      if (!earliest || candidate.localeCompare(earliest) < 0) {
        earliest = candidate;
      }
    }
    return earliest;
  }

  public prepareMutation(
    intentId: string,
    operation: ExecutionOperation,
    request: Record<string, unknown>,
    customTag: string | null,
    createdUtc: string,
  ): void {
    if (
      operation !== "place_order"
      && operation !== "close_position"
      && operation !== "modify_order"
    ) {
      throw new Error(`execution_mutation_operation_invalid:${operation}`);
    }

    this.inTransaction(() => {
      if (operation === "place_order") {
        const pending = this.entrySubmissionIntentId();
        if (pending) {
          throw new Error(`entry_submission_pending:${pending}`);
        }
      }

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

      if (operation === "place_order" && this.isProtectedEntryRequest(request)) {
        this.setMeta("entry_submission_latch", intentId);
      }
    });
  }

  private isProtectedEntryRequest(request: Record<string, unknown>): boolean {
    return request.stopLossBracket !== undefined || request.takeProfitBracket !== undefined;
  }

  public markMutationSubmitting(intentId: string, atUtc: string): void {
    this.transitionMutation(intentId, ["prepared"], "submitting", {
      submittingUtc: atUtc,
      resolvedUtc: null,
      providerOrderId: null,
      lastError: null,
    });
  }

  public noteMutationProviderOrderId(intentId: string, orderId: number): void {
    this.inTransaction(() => {
      const current = this.database.prepare(`
        SELECT state, provider_order_id
        FROM execution_outbox
        WHERE intent_id = ?
      `).get(intentId) as SqlRow | undefined;
      if (!current || !["submitting", "ambiguous"].includes(String(current.state))) {
        throw new Error(`execution_mutation_provider_order_note_invalid:${intentId}`);
      }
      this.database.prepare(`
        UPDATE execution_outbox
        SET provider_order_id = ?
        WHERE intent_id = ?
      `).run(orderId, intentId);
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
    }, true);
  }

  public markMutationRejected(intentId: string, error: string, atUtc: string): void {
    this.transitionMutation(intentId, ["submitting"], "rejected", {
      resolvedUtc: atUtc,
      providerOrderId: null,
      lastError: error,
    }, true);
  }

  public markMutationAmbiguous(intentId: string, error: string, atUtc: string): void {
    this.transitionMutation(intentId, ["submitting", "ambiguous"], "ambiguous", {
      resolvedUtc: null,
      lastError: error,
    });
  }

  public entrySubmissionIntentId(): string | null {
    return this.meta("entry_submission_latch");
  }

  public clearEntrySubmissionLatch(intentId: string): boolean {
    const result = this.database.prepare(`
      DELETE FROM runtime_meta
      WHERE key = 'entry_submission_latch' AND value = ?
    `).run(intentId);
    return Number(result.changes) === 1;
  }

  public mutationForIntent(intentId: string): StoredExecutionMutation | null {
    const row = this.database.prepare(`
      SELECT
        intent_id, operation, state, custom_tag, request_json, created_utc,
        submitting_utc, resolved_utc, provider_order_id, last_error
      FROM execution_outbox
      WHERE intent_id = ?
    `).get(intentId) as SqlRow | undefined;
    return row ? this.mutationFromRow(row) : null;
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

  public terminalMutationsWithoutReceipts(): StoredExecutionMutation[] {
    const rows = this.database.prepare(`
      SELECT
        outbox.intent_id,
        outbox.operation,
        outbox.state,
        outbox.custom_tag,
        outbox.request_json,
        outbox.created_utc,
        outbox.submitting_utc,
        outbox.resolved_utc,
        outbox.provider_order_id,
        outbox.last_error
      FROM execution_outbox AS outbox
      LEFT JOIN execution_receipts AS receipt
        ON receipt.intent_id = outbox.intent_id
      WHERE receipt.intent_id IS NULL
        AND outbox.state IN ('submitted', 'confirmed_not_submitted', 'rejected')
      ORDER BY outbox.created_utc ASC
    `).all() as SqlRow[];
    return rows.map((row) => this.mutationFromRow(row));
  }

  public intentsWithoutReceiptsOrMutations(): StoredIntentWithoutExecution[] {
    const rows = this.database.prepare(`
      SELECT intent.intent_id, intent.action, intent.received_utc
      FROM intents AS intent
      LEFT JOIN execution_outbox AS outbox
        ON outbox.intent_id = intent.intent_id
      LEFT JOIN execution_receipts AS receipt
        ON receipt.intent_id = intent.intent_id
      WHERE outbox.intent_id IS NULL
        AND receipt.intent_id IS NULL
      ORDER BY intent.received_utc ASC
    `).all() as SqlRow[];
    return rows.map((row) => ({
      intentId: String(row.intent_id),
      action: String(row.action),
      receivedUtc: String(row.received_utc),
    }));
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
    const blockingAmbiguity = ambiguousMutations > 0;
    const entrySubmissionPending = this.entrySubmissionIntentId() !== null;
    return {
      blockingAmbiguity,
      entrySubmissionPending,
      blockingNewExposure: blockingAmbiguity || entrySubmissionPending,
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

  public submittedExitTargetIntentIds(): Set<string> {
    return queryExitTargetedIntentIds(this.database);
  }

  public hasOpenExitMutation(): boolean {
    const row = this.database.prepare(`
      SELECT 1 AS ok
      FROM intents AS intent
      JOIN execution_outbox AS outbox ON outbox.intent_id = intent.intent_id
      LEFT JOIN execution_receipts AS receipt ON receipt.intent_id = intent.intent_id
      WHERE intent.action = 'EXIT'
        AND outbox.state IN ('prepared', 'submitting', 'submitted')
        AND (
          receipt.status IS NULL
          OR receipt.status NOT IN ('rejected', 'ignored', 'ambiguous', 'closed')
        )
      LIMIT 1
    `).get() as { ok: number } | undefined;
    return row !== undefined;
  }

  public latchDailyCapture(tradingDayId: string, reachedUtc: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO daily_capture_locks (trading_day_id, reached_utc)
      VALUES (?, ?)
    `).run(tradingDayId, reachedUtc);
  }

  public isDailyCaptureLocked(tradingDayId: string | null): boolean {
    if (!tradingDayId) {
      return false;
    }
    return this.database.prepare(`
      SELECT 1 AS ok FROM daily_capture_locks WHERE trading_day_id = ?
    `).get(tradingDayId) !== undefined;
  }

  /**
   * Appends a lifecycle fact. Identity is `fact_id`; re-recording the same moment with
   * unchanged content is a no-op, and changed content lands as the next revision of the same
   * identity so corrections never fork into a new fact.
   */
  public recordExecutionFact(input: {
    intentId: string;
    phase: string;
    recordedUtc: string;
    factKey?: string;
    detail?: Record<string, unknown>;
    diagnostics?: LifecycleDiagnostics | Record<string, unknown>;
  }): ExecutionFactWrite {
    const factId = lifecycleFactId(input.intentId, input.factKey ?? input.phase);
    const detailJson = JSON.stringify(input.detail ?? {});
    const diagnosticsJson = JSON.stringify(input.diagnostics ?? {});
    const contentHash = createHash("sha256")
      .update(`${input.phase}\u0000${detailJson}\u0000${diagnosticsJson}`)
      .digest("hex");
    const latest = this.database.prepare(`
      SELECT sequence, revision, content_hash
      FROM execution_facts WHERE fact_id = ? ORDER BY revision DESC, sequence DESC LIMIT 1
    `).get(factId) as { sequence: number; revision: number; content_hash: string } | undefined;
    if (latest?.content_hash === contentHash) {
      return {
        sequence: Number(latest.sequence),
        factId,
        revision: Number(latest.revision),
        recorded: false,
      };
    }
    const revision = Number(latest?.revision ?? 0) + 1;
    const result = this.database.prepare(`
      INSERT INTO execution_facts (
        intent_id, phase, recorded_utc, detail_json, fact_id, revision, content_hash, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.intentId,
      input.phase,
      input.recordedUtc,
      detailJson,
      factId,
      revision,
      contentHash,
      diagnosticsJson,
    );
    return { sequence: Number(result.lastInsertRowid), factId, revision, recorded: true };
  }

  /**
   * Marks the intermediate facts of an intent as superseded once the revisioned outcome
   * carries the same truth. Rows are kept for audit and a terminal fact tells cursor
   * consumers to stop treating them as the freshest closure.
   */
  public supersedeExecutionFacts(intentId: string, supersededBy: string, atUtc: string): number {
    const updated = this.database.prepare(`
      UPDATE execution_facts
      SET superseded_utc = ?, superseded_by = ?
      WHERE intent_id = ? AND superseded_utc IS NULL AND phase <> 'outcome_superseded'
    `).run(atUtc, supersededBy, intentId);
    const count = Number(updated.changes);
    if (count > 0) {
      this.recordExecutionFact({
        intentId,
        phase: "outcome_superseded",
        recordedUtc: atUtc,
        detail: { superseded_by: supersededBy, superseded_facts: count },
      });
    }
    return count;
  }

  public executionFactsStatus(): { live: number; superseded: number; high_water_sequence: number } {
    const row = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN superseded_utc IS NULL THEN 1 ELSE 0 END), 0) AS live,
        COALESCE(SUM(CASE WHEN superseded_utc IS NULL THEN 0 ELSE 1 END), 0) AS superseded,
        COALESCE(MAX(sequence), 0) AS high
      FROM execution_facts
    `).get() as { live: number; superseded: number; high: number };
    return {
      live: Number(row.live),
      superseded: Number(row.superseded),
      high_water_sequence: Number(row.high),
    };
  }

  public executionFactsAfter(afterSequence: number, limit = 500): Record<string, unknown> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("execution_fact_cursor_invalid");
    }
    const rows = this.database.prepare(`
      SELECT sequence, intent_id, phase, recorded_utc, detail_json,
             fact_id, revision, content_hash, diagnostics_json, superseded_utc, superseded_by
      FROM execution_facts WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(afterSequence, limit) as Array<{
      sequence: number;
      intent_id: string;
      phase: string;
      recorded_utc: string;
      detail_json: string;
      fact_id: string;
      revision: number;
      content_hash: string;
      diagnostics_json: string;
      superseded_utc: string | null;
      superseded_by: string | null;
    }>;
    const high = this.database.prepare(`SELECT COALESCE(MAX(sequence), 0) AS high FROM execution_facts`)
      .get() as { high: number };
    return {
      schema_version: "glitch.topstep.execution_facts.v1",
      after_sequence: afterSequence,
      high_water_sequence: Number(high.high),
      count: rows.length,
      facts: rows.map((row) => ({
        sequence: Number(row.sequence),
        fact_id: row.fact_id,
        intent_id: row.intent_id,
        phase: row.phase,
        revision: Number(row.revision),
        recorded_utc: row.recorded_utc,
        status: row.superseded_utc === null ? "live" : "superseded_by_outcome",
        superseded_utc: row.superseded_utc,
        superseded_by: row.superseded_by,
        content_hash: row.content_hash,
        detail: JSON.parse(row.detail_json) as Record<string, unknown>,
        diagnostics: JSON.parse(row.diagnostics_json) as Record<string, unknown>,
      })),
    };
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
    this.applyMigration(2, `
      ALTER TABLE intents ADD COLUMN body_hash TEXT NOT NULL DEFAULT '';
      UPDATE intents SET body_hash = 'legacy:' || intent_id WHERE body_hash = '';
    `);
    this.applyMigration(3, `
      CREATE TABLE execution_outbox_v3 (
        intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
        operation TEXT NOT NULL CHECK(operation IN ('place_order', 'close_position', 'modify_order')),
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
      INSERT INTO execution_outbox_v3 (
        intent_id, operation, state, custom_tag, request_json, created_utc,
        submitting_utc, resolved_utc, provider_order_id, last_error
      )
      SELECT
        intent_id, operation, state, custom_tag, request_json, created_utc,
        submitting_utc, resolved_utc, provider_order_id, last_error
      FROM execution_outbox;
      DROP TABLE execution_outbox;
      ALTER TABLE execution_outbox_v3 RENAME TO execution_outbox;
      CREATE INDEX IF NOT EXISTS idx_execution_outbox_state
        ON execution_outbox(state, created_utc);
    `);
    this.applyMigration(4, `
      CREATE TABLE daily_capture_locks (
        trading_day_id TEXT PRIMARY KEY,
        reached_utc TEXT NOT NULL
      ) STRICT;
    `);
    this.applyMigration(5, `
      CREATE TABLE execution_facts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        recorded_utc TEXT NOT NULL,
        detail_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_execution_facts_intent ON execution_facts(intent_id, sequence);
    `);
    this.applyMigration(6, `
      CREATE TABLE protected_reductions (
        reduction_id TEXT PRIMARY KEY,
        exit_intent_id TEXT NOT NULL UNIQUE,
        target_intent_id TEXT,
        account_id INTEGER NOT NULL,
        contract_id TEXT NOT NULL,
        exit_quantity INTEGER NOT NULL,
        position_size_before INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'protected_active',
          'reduction_prepared',
          'reduction_submitting',
          'reduction_ambiguous',
          'reduced_protected',
          'degraded_stop_only',
          'flat',
          'failed'
        )),
        provider_exit_order_id INTEGER,
        survivor_stop_order_id INTEGER,
        survivor_target_order_id INTEGER,
        detail TEXT,
        created_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_protected_reductions_state
        ON protected_reductions(state, updated_utc);
    `);
    this.applyMigration(7, `
      ALTER TABLE execution_facts ADD COLUMN fact_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE execution_facts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE execution_facts ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE execution_facts ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE execution_facts ADD COLUMN superseded_utc TEXT;
      ALTER TABLE execution_facts ADD COLUMN superseded_by TEXT;
      UPDATE execution_facts SET fact_id = 'fact:' || intent_id || ':' || phase WHERE fact_id = '';
      CREATE INDEX idx_execution_facts_identity ON execution_facts(fact_id, revision);
    `);
  }

  public beginProtectedReduction(input: {
    reductionId: string;
    exitIntentId: string;
    targetIntentId: string | null;
    accountId: number;
    contractId: string;
    exitQuantity: number;
    positionSizeBefore: number;
    survivorStopOrderId: number | null;
    survivorTargetOrderId: number | null;
    nowUtc: string;
  }): ProtectedReductionRecord {
    transitionProtectedReduction(null, "reduction_prepared", input.reductionId, "begin");
    this.database.prepare(`
      INSERT INTO protected_reductions (
        reduction_id, exit_intent_id, target_intent_id, account_id, contract_id,
        exit_quantity, position_size_before, state,
        provider_exit_order_id, survivor_stop_order_id, survivor_target_order_id,
        detail, created_utc, updated_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reduction_prepared', NULL, ?, ?, NULL, ?, ?)
    `).run(
      input.reductionId,
      input.exitIntentId,
      input.targetIntentId,
      input.accountId,
      input.contractId,
      input.exitQuantity,
      input.positionSizeBefore,
      input.survivorStopOrderId,
      input.survivorTargetOrderId,
      input.nowUtc,
      input.nowUtc,
    );
    return this.protectedReductionByExitIntent(input.exitIntentId)!;
  }

  public advanceProtectedReduction(
    exitIntentId: string,
    to: ProtectedReductionState,
    reason: string,
    nowUtc: string,
    patch: {
      providerExitOrderId?: number | null;
      survivorStopOrderId?: number | null;
      survivorTargetOrderId?: number | null;
      detail?: string | null;
    } = {},
  ): ProtectedReductionRecord {
    const current = this.protectedReductionByExitIntent(exitIntentId);
    if (!current) {
      throw new Error(`protected_reduction_not_found:${exitIntentId}`);
    }
    transitionProtectedReduction(current.state, to, current.reduction_id, reason, nowUtc);
    this.database.prepare(`
      UPDATE protected_reductions
      SET state = ?,
          provider_exit_order_id = COALESCE(?, provider_exit_order_id),
          survivor_stop_order_id = COALESCE(?, survivor_stop_order_id),
          survivor_target_order_id = COALESCE(?, survivor_target_order_id),
          detail = COALESCE(?, detail),
          updated_utc = ?
      WHERE exit_intent_id = ?
    `).run(
      to,
      patch.providerExitOrderId ?? null,
      patch.survivorStopOrderId ?? null,
      patch.survivorTargetOrderId ?? null,
      patch.detail ?? null,
      nowUtc,
      exitIntentId,
    );
    return this.protectedReductionByExitIntent(exitIntentId)!;
  }

  public protectedReductionByExitIntent(exitIntentId: string): ProtectedReductionRecord | null {
    const row = this.database.prepare(`
      SELECT *
      FROM protected_reductions
      WHERE exit_intent_id = ?
    `).get(exitIntentId) as SqlRow | undefined;
    return row ? this.mapProtectedReduction(row) : null;
  }

  public activeProtectedReduction(): ProtectedReductionRecord | null {
    const row = this.database.prepare(`
      SELECT *
      FROM protected_reductions
      WHERE state NOT IN ('flat', 'failed', 'reduced_protected')
      ORDER BY updated_utc DESC
      LIMIT 1
    `).get() as SqlRow | undefined;
    return row ? this.mapProtectedReduction(row) : null;
  }

  public markProtectedReductionsFlat(nowUtc: string): number {
    const result = this.database.prepare(`
      UPDATE protected_reductions
      SET state = 'flat', updated_utc = ?, detail = COALESCE(detail, 'venue_flat')
      WHERE state NOT IN ('flat', 'failed')
    `).run(nowUtc);
    return Number(result.changes ?? 0);
  }

  private mapProtectedReduction(row: SqlRow): ProtectedReductionRecord {
    return {
      reduction_id: String(row.reduction_id),
      exit_intent_id: String(row.exit_intent_id),
      target_intent_id: row.target_intent_id == null ? null : String(row.target_intent_id),
      account_id: Number(row.account_id),
      contract_id: String(row.contract_id),
      exit_quantity: Number(row.exit_quantity),
      position_size_before: Number(row.position_size_before),
      state: String(row.state) as ProtectedReductionState,
      provider_exit_order_id: row.provider_exit_order_id == null
        ? null
        : Number(row.provider_exit_order_id),
      survivor_stop_order_id: row.survivor_stop_order_id == null
        ? null
        : Number(row.survivor_stop_order_id),
      survivor_target_order_id: row.survivor_target_order_id == null
        ? null
        : Number(row.survivor_target_order_id),
      detail: row.detail == null ? null : String(row.detail),
      created_utc: String(row.created_utc),
      updated_utc: String(row.updated_utc),
    };
  }

  private applyMigration(version: number, sql: string): void {
    const applied = this.database.prepare(`
      SELECT version FROM schema_migrations WHERE version = ?
    `).get(version) as SqlRow | undefined;
    if (applied) {
      return;
    }
    this.inTransaction(() => {
      this.database.exec(sql);
      this.database.prepare(`
      INSERT INTO schema_migrations(version, applied_utc)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(version);
    });
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
    clearEntryLatch = false,
  ): void {
    this.inTransaction(() => {
      const current = this.database.prepare(`
        SELECT state, submitting_utc, resolved_utc, provider_order_id, last_error
        FROM execution_outbox
        WHERE intent_id = ?
      `).get(intentId) as SqlRow | undefined;
      if (!current) {
        throw new Error(`execution_mutation_not_found:${intentId}`);
      }
      const state = String(current.state) as ExecutionMutationState;
      if (state === nextState) {
        return;
      }
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
      if (clearEntryLatch) {
        this.database.prepare(`
          DELETE FROM runtime_meta
          WHERE key = 'entry_submission_latch' AND value = ?
        `).run(intentId);
      }
    });
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
