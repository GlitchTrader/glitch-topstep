import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { DurableControlStore } from "../src/control/durable-control-store.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { SqliteOutcomeFeed } from "../src/storage/sqlite-outcome-feed.js";

function installPrepareGuard(database: DatabaseSync): { prepareCalls: number } {
  const state = { prepareCalls: 0 };
  const original = database.prepare.bind(database);
  database.prepare = ((...args: Parameters<DatabaseSync["prepare"]>) => {
    state.prepareCalls += 1;
    return original(...args);
  }) as DatabaseSync["prepare"];
  return state;
}

function dbOf(store: object): DatabaseSync {
  return (store as { database: DatabaseSync }).database;
}

describe("health SQLite isolation peeks", () => {
  it("execution peekRecoveryStatus never touches DatabaseSync when cache is cold", () => {
    const store = new SqliteExecutionStore(":memory:");
    const guard = installPrepareGuard(dbOf(store));
    assert.equal(store.peekRecoveryStatus(), null);
    assert.equal(store.isRecoveryCacheStale(), true);
    assert.equal(guard.prepareCalls, 0);
    store.close();
  });

  it("execution peekRecoveryStatus stays off SQLite after write invalidates cache", () => {
    const store = new SqliteExecutionStore(":memory:");
    const heated = store.recoveryStatus();
    assert.equal(store.isRecoveryCacheStale(), false);
    // setMeta + inTransaction both mark stale while keeping last peek (no live fallback).
    store.recordRecoveryResult(new Date().toISOString(), null);
    assert.equal(store.isRecoveryCacheStale(), true);
    assert.deepEqual(store.peekRecoveryStatus(), heated);
    const guard = installPrepareGuard(dbOf(store));
    assert.deepEqual(store.peekRecoveryStatus(), heated);
    assert.equal(store.peekUnprotectedSinceUtc(), null);
    assert.equal(guard.prepareCalls, 0);
    store.close();
  });

  it("execution peekUnprotectedSinceUtc never live-reads when cold", () => {
    const store = new SqliteExecutionStore(":memory:");
    const guard = installPrepareGuard(dbOf(store));
    assert.equal(store.peekUnprotectedSinceUtc(), null);
    assert.equal(store.isUnprotectedSinceCacheStale(), true);
    assert.equal(guard.prepareCalls, 0);
    store.close();
  });

  it("control health peeks never touch DatabaseSync on cold or after write stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-health-"));
    const store = new DurableControlStore(join(dir, "controls.sqlite"));
    const coldGuard = installPrepareGuard(dbOf(store));
    assert.deepEqual(store.peekStatus(), {
      pending: 0,
      applying: 0,
      completed: 0,
      rejected: 0,
      failed: 0,
    });
    assert.equal(store.peekHasPendingFlatten(), false);
    assert.equal(store.peekOldestPendingFlattenAgeMs(), null);
    assert.equal(coldGuard.prepareCalls, 0);

    store.refreshHealthCache();
    assert.equal(store.isHealthCacheWarmed(), true);
    assert.equal(store.isHealthCacheStale(), false);

    store.submit({
      schema_version: "glitch.topstep.control.v1",
      control_id: "00000000-0000-4000-8000-000000000099",
      action: "pause",
      account_id: 1,
      contract_id: null,
      issuer: "test",
      created_utc: new Date().toISOString(),
      reason: "health_isolation_test",
    });
    assert.equal(store.isHealthCacheStale(), true);

    const staleGuard = installPrepareGuard(dbOf(store));
    store.peekStatus();
    store.peekHasPendingFlatten();
    store.peekOldestPendingFlattenAgeMs(Date.now());
    assert.equal(staleGuard.prepareCalls, 0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("outcome feed peekStatus never touches DatabaseSync on cold or after publish stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "out-health-"));
    const feed = new SqliteOutcomeFeed(join(dir, "outcomes.sqlite"));
    const coldGuard = installPrepareGuard(dbOf(feed));
    assert.deepEqual(feed.peekStatus(), {
      current_count: 0,
      revision_count: 0,
      high_water_sequence: 0,
      integrity: "ok",
      integrity_error: null,
    });
    assert.equal(coldGuard.prepareCalls, 0);

    feed.refreshHealthCache();
    assert.equal(feed.isHealthCacheWarmed(), true);

    feed.publish({
      schema_version: "glitch.topstep.trade_outcome.v1",
      outcome_id: "out-1",
      intent_id: "intent-1",
      account: "test",
      instrument: "MNQ",
      entry_utc: "2026-09-28T12:00:00Z",
      exit_utc: "2026-09-28T12:05:00Z",
      realized_pnl_usd: 1,
      fees_usd: 0,
      learning_eligible: false,
    }, "provisional");
    assert.equal(feed.isHealthCacheStale(), true);

    const staleGuard = installPrepareGuard(dbOf(feed));
    feed.peekStatus();
    assert.equal(staleGuard.prepareCalls, 0);
    feed.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
