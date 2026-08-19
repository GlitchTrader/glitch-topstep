import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TradingMode } from "../domain/models.js";

export type ControlAction = "pause" | "resume" | "set_mode" | "flatten";
export type ControlStatus = "pending" | "applying" | "completed" | "rejected" | "failed";

export interface ControlCommand {
  schema_version: "glitch.topstep.control.v1";
  control_id: string;
  action: ControlAction;
  account_id: number;
  contract_id: string | null;
  issuer: string;
  created_utc: string;
  mode?: TradingMode;
  reason: string;
}

export interface StoredControlCommand extends ControlCommand {
  sequence: number;
  content_hash: string;
  status: ControlStatus;
  updated_utc: string;
  detail: string | null;
}

export class DurableControlStore {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS control_commands (
        control_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        sequence INTEGER,
        created_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL,
        detail TEXT
      );
    `);
    const columns = this.database.prepare(`PRAGMA table_info(control_commands)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "sequence")) {
      this.database.exec(`ALTER TABLE control_commands ADD COLUMN sequence INTEGER`);
    }
    this.database.exec(`
      UPDATE control_commands SET sequence = rowid WHERE sequence IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_control_commands_sequence
        ON control_commands(sequence);
    `);
  }

  public close(): void {
    this.database.close();
  }

  public submit(command: ControlCommand, nowUtc = new Date().toISOString()): StoredControlCommand {
    validateControlCommand(command);
    const payloadJson = JSON.stringify(command);
    const contentHash = createHash("sha256").update(payloadJson).digest("hex");
    const existing = this.get(command.control_id);
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new Error("control_id_content_conflict");
      }
      return existing;
    }
    this.inTransaction(() => {
      const sequenceRow = this.database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM control_commands
      `).get() as { next_sequence: number };
      this.database.prepare(`
        INSERT INTO control_commands (
          control_id, content_hash, payload_json, status, sequence, created_utc, updated_utc, detail
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL)
      `).run(
        command.control_id,
        contentHash,
        payloadJson,
        Number(sequenceRow.next_sequence),
        command.created_utc,
        nowUtc,
      );
    });
    return this.get(command.control_id)!;
  }

  public transition(
    controlId: string,
    status: ControlStatus,
    detail: string | null = null,
    nowUtc = new Date().toISOString(),
  ): StoredControlCommand {
    const result = this.database.prepare(`
      UPDATE control_commands SET status = ?, detail = ?, updated_utc = ? WHERE control_id = ?
    `).run(status, detail, nowUtc, controlId);
    if (Number(result.changes) !== 1) {
      throw new Error("control_not_found");
    }
    return this.get(controlId)!;
  }

  public claimPending(controlId: string, nowUtc = new Date().toISOString()): StoredControlCommand | null {
    const result = this.database.prepare(`
      UPDATE control_commands
      SET status = 'applying', updated_utc = ?
      WHERE control_id = ? AND status = 'pending'
    `).run(nowUtc, controlId);
    return Number(result.changes) === 1 ? this.get(controlId) : null;
  }

  public effectiveState(accountId: number, contractId: string): { paused: boolean; mode: TradingMode | null } {
    const rows = this.database.prepare(`
      SELECT payload_json FROM control_commands
      WHERE json_extract(payload_json, '$.account_id') = ? AND status = 'completed'
        AND (json_extract(payload_json, '$.contract_id') IS NULL OR json_extract(payload_json, '$.contract_id') = ?)
      ORDER BY sequence ASC
    `).all(accountId, contractId) as Array<{ payload_json: string }>;
    let paused = false;
    let mode: TradingMode | null = null;
    for (const row of rows) {
      const command = JSON.parse(row.payload_json) as ControlCommand;
      if (command.action === 'pause') paused = true;
      if (command.action === 'resume') paused = false;
      if (command.action === 'set_mode' && command.mode) mode = command.mode;
    }
    return { paused, mode };
  }

  public get(controlId: string): StoredControlCommand | null {
    const row = this.database.prepare(`
      SELECT sequence, content_hash, payload_json, status, updated_utc, detail
      FROM control_commands WHERE control_id = ?
    `).get(controlId) as {
      sequence: number;
      content_hash: string;
      payload_json: string;
      status: ControlStatus;
      updated_utc: string;
      detail: string | null;
    } | undefined;
    if (!row) {
      return null;
    }
    return {
      ...(JSON.parse(row.payload_json) as ControlCommand),
      sequence: Number(row.sequence),
      content_hash: row.content_hash,
      status: row.status,
      updated_utc: row.updated_utc,
      detail: row.detail,
    };
  }

  public pending(): StoredControlCommand[] {
    const rows = this.database.prepare(`
      SELECT control_id FROM control_commands
      WHERE status IN ('pending', 'applying') ORDER BY sequence ASC
    `).all() as Array<{ control_id: string }>;
    return rows.map((row) => this.get(row.control_id)!);
  }

  public status(): Record<ControlStatus, number> {
    const result = { pending: 0, applying: 0, completed: 0, rejected: 0, failed: 0 };
    const rows = this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM control_commands GROUP BY status
    `).all() as Array<{ status: ControlStatus; count: number }>;
    for (const row of rows) {
      result[row.status] = Number(row.count);
    }
    return result;
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

export function parseControlCommand(input: unknown): ControlCommand {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("control_must_be_object");
  }
  const row = input as Record<string, unknown>;
  const command = {
    schema_version: row.schema_version,
    control_id: row.control_id,
    action: row.action,
    account_id: row.account_id,
    contract_id: row.contract_id,
    issuer: row.issuer,
    created_utc: row.created_utc,
    mode: row.mode,
    reason: row.reason,
  } as ControlCommand;
  validateControlCommand(command);
  return command;
}

function validateControlCommand(command: ControlCommand): void {
  if (command.schema_version !== "glitch.topstep.control.v1") {
    throw new Error("control_schema_invalid");
  }
  if (!/^[0-9a-f-]{36}$/i.test(command.control_id)) {
    throw new Error("control_id_invalid");
  }
  if (!["pause", "resume", "set_mode", "flatten"].includes(command.action)) {
    throw new Error("control_action_invalid");
  }
  if (!Number.isInteger(command.account_id) || command.account_id <= 0) {
    throw new Error("control_account_invalid");
  }
  if (command.contract_id !== null && (typeof command.contract_id !== "string" || !command.contract_id)) {
    throw new Error("control_contract_invalid");
  }
  if (typeof command.issuer !== "string" || !command.issuer.trim()) {
    throw new Error("control_issuer_invalid");
  }
  if (!Number.isFinite(Date.parse(command.created_utc))) {
    throw new Error("control_timestamp_invalid");
  }
  if (typeof command.reason !== "string" || !command.reason.trim()) {
    throw new Error("control_reason_invalid");
  }
  if (command.action === "set_mode" && !["disabled", "shadow", "armed"].includes(command.mode ?? "")) {
    throw new Error("control_mode_invalid");
  }
}
