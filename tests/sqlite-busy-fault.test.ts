/**
 * TS-REAUDIT-10 fault matrix: SQLite busy/lock contention against the real driver and the real
 * pragmas this project uses (WAL, busy_timeout), not a mock. Proves lock contention is a
 * transient, catchable condition -- not a process crash and not a stuck/corrupted connection.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TradeIntent } from "../src/domain/models.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

function nothingIntent(intentId: string, createdUtc: string): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId,
    createdUtc,
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action: "NOTHING",
    confidence: 0.5,
    snapshotHash: "hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v17.1",
    reason: "Test.",
    decisionAudit: {
      bullCase: "Bull.",
      bearCase: "Bear.",
      flatCase: "Flat.",
      aggressiveCase: "Aggressive.",
      conservativeCase: "Conservative.",
      decisiveEvidence: "Evidence.",
      disconfirmingEvidence: "Counter.",
      changeCondition: "Change.",
      finalChoice: "NOTHING",
    },
  };
}

describe("SQLite busy fault (TS-REAUDIT-10)", () => {
  it("write-lock contention throws a catchable busy error, and a fresh writer recovers once the lock releases", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-sqlite-busy-"));
    const dbPath = join(directory, "contention.sqlite");
    try {
      // Holder: acquires the write lock via BEGIN IMMEDIATE and never commits until the test
      // says so. No default (5s) busy_timeout matters here -- it's the one holding the lock.
      const holder = new DatabaseSync(dbPath);
      holder.exec("PRAGMA journal_mode=WAL");
      try {
        holder.exec("BEGIN IMMEDIATE");

        // Contender: a short busy_timeout so this test doesn't wait out a real 5s timeout to
        // observe the contention.
        const contender = new DatabaseSync(dbPath);
        contender.exec("PRAGMA busy_timeout=50");
        try {
          assert.throws(
            () => {
              contender.exec("BEGIN IMMEDIATE");
            },
            (error: unknown) => {
              // A catchable JS error -- the process itself not crashing on the throw is half the
              // proof. Node's node:sqlite driver reports lock contention as ERR_SQLITE_ERROR
              // with an errstr mentioning "locked" or "busy".
              assert.ok(error instanceof Error);
              const detail = `${(error as { message?: string }).message ?? ""} ${(error as { errstr?: string }).errstr ?? ""}`;
              assert.match(detail, /locked|busy/i);
              return true;
            },
          );
        } finally {
          contender.close();
        }

        holder.exec("ROLLBACK");
      } finally {
        holder.close();
      }

      // The lock is released -- a completely fresh connection through the project's real store
      // class (its normal 5000ms busy_timeout) must write cleanly and immediately, proving the
      // earlier contention left the database file in a usable, uncorrupted state.
      const store = new SqliteExecutionStore(dbPath);
      try {
        const startedMs = Date.now();
        assert.doesNotThrow(() => {
          store.registerIntent(
            nothingIntent("00000000-0000-4000-8000-000000000303", "2026-08-31T00:00:02Z"),
            "2026-08-31T00:00:02Z",
          );
        });
        assert.ok(Date.now() - startedMs < 1_000, "recovery write must not itself hit contention");
        assert.ok(store.registeredIntentPayload("00000000-0000-4000-8000-000000000303"));
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
