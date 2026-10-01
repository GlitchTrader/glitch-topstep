import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqlitePersistence } from "../src/storage/sqlite-persistence.js";

describe("sqlite off the gateway main thread", () => {
  it("a busy persistence worker does not stall main-thread timers", async () => {
    const persistence = new SqlitePersistence({
      execution: ":memory:",
      evidence: ":memory:",
      control: ":memory:",
      outcome: ":memory:",
      ownership: null,
    });
    try {
      await persistence.whenReady();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);
      const blocking = persistence.delay(80);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(ticks >= 1, `main thread kept ticking during worker delay, saw ${ticks}`);
      await blocking;
      clearInterval(timer);
      const status = await persistence.call("execution", "recoveryStatus", []);
      assert.equal(typeof status, "object");
      assert.ok(status !== null && "unresolvedMutations" in (status as object));
    } finally {
      await persistence.close();
    }
  });

  it("the gateway process does not construct DatabaseSync stores on the main thread", () => {
    const service = readFileSync(join(process.cwd(), "src", "service.ts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "src", "storage", "sqlite-worker.ts"), "utf8");
    for (const banned of [
      "new DatabaseSync",
      "new SqliteExecutionStore",
      "new SqliteProviderEvidenceStore",
      "new DurableControlStore",
      "new SqliteOutcomeFeed",
      "new ProjectXOrderOwnershipService",
    ]) {
      assert.equal(service.includes(banned), false, banned);
    }
    assert.match(service, /new SqlitePersistence/);
    assert.match(worker, /new SqliteExecutionStore/);
    const execution = readFileSync(join(process.cwd(), "src", "storage", "sqlite-execution-store.ts"), "utf8");
    assert.match(execution, /PRAGMA synchronous=FULL/);
  });
});
