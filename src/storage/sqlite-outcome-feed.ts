import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";

export type OutcomeRevisionStatus = "provisional" | "enriched" | "corrected";

export interface OutcomeRevision {
  sequence: number;
  outcome_id: string;
  intent_id: string;
  revision: number;
  status: OutcomeRevisionStatus;
  content_hash: string;
  recorded_utc: string;
  outcome: TradeOutcomeV1;
}

export interface OutcomeRevisionPage {
  schema_version: "glitch.topstep.outcome_feed.v1";
  retention_floor_sequence: number;
  high_water_sequence: number;
  after_sequence: number;
  count: number;
  revisions: OutcomeRevision[];
}

export interface OutcomeFeedStatus {
  current_count: number;
  revision_count: number;
  high_water_sequence: number;
  integrity: "ok" | "failed";
  integrity_error: string | null;
}

export class SqliteOutcomeFeed {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS outcome_revisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        outcome_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recorded_utc TEXT NOT NULL,
        UNIQUE(outcome_id, revision)
      );
      CREATE TABLE IF NOT EXISTS outcomes_current (
        outcome_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_utc TEXT NOT NULL
      );
    `);
  }

  public close(): void {
    this.database.close();
  }

  public publish(
    outcome: TradeOutcomeV1,
    status: OutcomeRevisionStatus,
    recordedUtc = new Date().toISOString(),
  ): OutcomeRevision {
    const payloadJson = JSON.stringify(outcome);
    const contentHash = createHash("sha256").update(payloadJson).digest("hex");
    const existing = this.database.prepare(`
      SELECT revision, sequence, status, content_hash, updated_utc
      FROM outcomes_current WHERE outcome_id = ?
    `).get(outcome.outcome_id) as {
      revision: number;
      sequence: number;
      status: OutcomeRevisionStatus;
      content_hash: string;
      updated_utc: string;
    } | undefined;
    if (existing?.content_hash === contentHash && existing.status === status) {
      return {
        sequence: Number(existing.sequence),
        outcome_id: outcome.outcome_id,
        intent_id: outcome.intent_id,
        revision: Number(existing.revision),
        status: existing.status,
        content_hash: contentHash,
        recorded_utc: existing.updated_utc,
        outcome,
      };
    }
    const revision = Number(existing?.revision ?? 0) + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.prepare(`
        INSERT INTO outcome_revisions (
          outcome_id, intent_id, revision, status, content_hash, payload_json, recorded_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(outcome.outcome_id, outcome.intent_id, revision, status, contentHash, payloadJson, recordedUtc);
      const sequence = Number(inserted.lastInsertRowid);
      this.database.prepare(`
        INSERT INTO outcomes_current (
          outcome_id, intent_id, revision, sequence, status, content_hash, payload_json, updated_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outcome_id) DO UPDATE SET
          intent_id=excluded.intent_id,
          revision=excluded.revision,
          sequence=excluded.sequence,
          status=excluded.status,
          content_hash=excluded.content_hash,
          payload_json=excluded.payload_json,
          updated_utc=excluded.updated_utc
      `).run(
        outcome.outcome_id,
        outcome.intent_id,
        revision,
        sequence,
        status,
        contentHash,
        payloadJson,
        recordedUtc,
      );
      this.database.exec("COMMIT");
      return {
        sequence,
        outcome_id: outcome.outcome_id,
        intent_id: outcome.intent_id,
        revision,
        status,
        content_hash: contentHash,
        recorded_utc: recordedUtc,
        outcome,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public current(): TradeOutcomeV1[] {
    const rows = this.database.prepare(`
      SELECT payload_json FROM outcomes_current ORDER BY sequence ASC
    `).all() as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as TradeOutcomeV1);
  }

  public status(): OutcomeFeedStatus {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM outcomes_current) AS current_count,
        (SELECT COUNT(*) FROM outcome_revisions) AS revision_count,
        COALESCE((SELECT MAX(sequence) FROM outcome_revisions), 0) AS high_water_sequence
    `).get() as { current_count: number; revision_count: number; high_water_sequence: number };
    try {
      const result = this.database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      const value = result.integrity_check ?? "failed";
      return {
        current_count: Number(counts.current_count),
        revision_count: Number(counts.revision_count),
        high_water_sequence: Number(counts.high_water_sequence),
        integrity: value === "ok" ? "ok" : "failed",
        integrity_error: value === "ok" ? null : value,
      };
    } catch (error) {
      return {
        current_count: Number(counts.current_count),
        revision_count: Number(counts.revision_count),
        high_water_sequence: Number(counts.high_water_sequence),
        integrity: "failed",
        integrity_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public afterSequence(afterSequence: number, limit = 500): OutcomeRevisionPage {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("outcome_after_sequence_invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("outcome_feed_limit_invalid");
    }
    const bounds = this.database.prepare(`
      SELECT COALESCE(MIN(sequence), 0) AS floor, COALESCE(MAX(sequence), 0) AS high
      FROM outcome_revisions
    `).get() as { floor: number; high: number };
    const floor = Number(bounds.floor);
    if (floor > 0 && afterSequence > 0 && afterSequence < floor - 1) {
      throw new Error(`outcome_cursor_before_retention_floor:${floor}`);
    }
    const rows = this.database.prepare(`
      SELECT sequence, outcome_id, intent_id, revision, status, content_hash, payload_json, recorded_utc
      FROM outcome_revisions WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(afterSequence, limit) as Array<{
      sequence: number;
      outcome_id: string;
      intent_id: string;
      revision: number;
      status: OutcomeRevisionStatus;
      content_hash: string;
      payload_json: string;
      recorded_utc: string;
    }>;
    const revisions = rows.map((row) => ({
      sequence: Number(row.sequence),
      outcome_id: row.outcome_id,
      intent_id: row.intent_id,
      revision: Number(row.revision),
      status: row.status,
      content_hash: row.content_hash,
      recorded_utc: row.recorded_utc,
      outcome: JSON.parse(row.payload_json) as TradeOutcomeV1,
    }));
    return {
      schema_version: "glitch.topstep.outcome_feed.v1",
      retention_floor_sequence: floor,
      high_water_sequence: Number(bounds.high),
      after_sequence: afterSequence,
      count: revisions.length,
      revisions,
    };
  }
}
