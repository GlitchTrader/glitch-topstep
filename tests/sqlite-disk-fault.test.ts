/**
 * TS-REAUDIT-10: disk-full and SQLite corruption are catchable. Does not fill the
 * real volume — SQLITE_FULL is forced with max_page_count (same errstr class as ENOSPC).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TradeIntent } from "../src/domain/models.js";
import { isCatchableDiskFault } from "../src/storage/disk-fault.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

function nothingIntent(): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: "00000000-0000-4000-8000-000000000404",
    createdUtc: "2026-09-25T00:00:00Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action: "NOTHING",
    confidence: 0.5,
    snapshotHash: "hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v17.3",
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

describe("SQLite disk faults (TS-REAUDIT-10)", () => {
  it("classifies Node ENOSPC as a catchable disk fault", () => {
    const error = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    assert.equal(isCatchableDiskFault(error), true);
    assert.equal(isCatchableDiskFault(new Error("SQLITE_BUSY: database is locked")), false);
  });

  it("SQLITE_FULL from max_page_count is catchable and a later write recovers", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-sqlite-full-"));
    const dbPath = join(directory, "full.sqlite");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE t (x BLOB)");
      db.exec("PRAGMA max_page_count=2");
      let sawFull = false;
      try {
        for (let i = 0; i < 30; i += 1) {
          db.prepare("INSERT INTO t VALUES (?)").run(Buffer.alloc(8_000));
        }
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.equal(isCatchableDiskFault(error), true);
        sawFull = true;
      } finally {
        db.close();
      }
      assert.equal(sawFull, true);

      const recover = new DatabaseSync(dbPath);
      try {
        recover.exec("PRAGMA max_page_count=100");
        recover.exec("INSERT INTO t VALUES (x'00')");
      } finally {
        recover.close();
      }

      const store = new SqliteExecutionStore(dbPath);
      try {
        assert.doesNotThrow(() => {
          store.registerIntent(nothingIntent(), "2026-09-25T00:00:00Z");
        });
      } finally {
        store.close();
      }
    } finally {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 8 });
      } catch {
        // ponytail: Windows can keep a WAL lock for a moment after close.
      }
    }
  });

  it("opening a truncated sqlite file throws catchable corruption, process stays up", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-topstep-sqlite-corrupt-"));
    const dbPath = join(directory, "corrupt.sqlite");
    writeFileSync(dbPath, "this is not a database");
    try {
      const bad = new DatabaseSync(dbPath);
      try {
        assert.throws(
          () => bad.exec("PRAGMA journal_mode=WAL"),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(isCatchableDiskFault(error), true);
            return true;
          },
        );
      } finally {
        bad.close();
      }
      const store = new SqliteExecutionStore(join(directory, "fresh.sqlite"));
      try {
        assert.doesNotThrow(() => {
          store.registerIntent(nothingIntent(), "2026-09-25T00:00:00Z");
        });
      } finally {
        store.close();
      }
    } finally {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 8 });
      } catch {
        // ponytail: Windows can keep a WAL lock for a moment after close.
      }
    }
  });
});
