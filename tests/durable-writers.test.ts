import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TradeOutcomeV1 } from "../src/learning/trade-outcome.js";
import { writeFileAtomic } from "../src/storage/atomic-file.js";
import { JsonlEventStore, type LedgerEvent } from "../src/storage/jsonl-event-store.js";
import { TradeOutcomeStore } from "../src/storage/trade-outcome-store.js";

function outcome(index: number): TradeOutcomeV1 {
  return {
    schema_version: "glitch.topstep.trade_outcome.v1",
    outcome_id: `outcome-${index}`,
    intent_id: `intent-${index}`,
    account: "SIM",
    instrument: "MNQ",
    entry_utc: "2026-08-20T12:00:00.000Z",
    exit_utc: "2026-08-20T12:01:00.000Z",
    realized_pnl_usd: index,
    fees_usd: 2,
    learning_eligible: false,
  };
}

function event(index: number): LedgerEvent {
  return {
    schema_version: "glitch.direct.event.v1",
    event_id: `event-${index}`,
    recorded_utc: "2026-08-20T12:00:00.000Z",
    event: "test_event",
    payload: { index },
  };
}

async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0);
}

test("atomic replace leaves no temp residue and cleans up after a failed rename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-write-"));
  const path = join(directory, "export.jsonl");
  try {
    await writeFile(path, "stale\n", "utf8");
    await writeFileAtomic(path, "fresh\n");
    assert.equal(await readFile(path, "utf8"), "fresh\n");
    assert.deepEqual(await readdir(directory), ["export.jsonl"]);

    // A directory in the target slot makes the rename fail the way a locked or
    // permission-denied target would; the temp file must not survive it.
    const blocked = join(directory, "blocked.jsonl");
    await mkdir(blocked);
    await assert.rejects(writeFileAtomic(blocked, "fresh\n"));
    assert.deepEqual((await readdir(directory)).sort(), ["blocked.jsonl", "export.jsonl"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt export tail is quarantined instead of skipped or fatal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcome-corrupt-"));
  const path = join(directory, "trade-outcomes.jsonl");
  try {
    const good = [outcome(1), outcome(2)].map((row) => `${JSON.stringify(row)}\n`).join("");
    // A torn write: the process died mid-line.
    await writeFile(path, `${good}{"intent_id":"intent-3","realiz`, "utf8");

    const store = new TradeOutcomeStore(directory);
    try {
      await store.load();
      assert.deepEqual(store.all().map((row) => row.intent_id), ["intent-1", "intent-2"]);
      const quarantine = store.status().quarantine;
      assert.ok(quarantine, "corrupt tail was silently dropped");
      assert.match(quarantine.reason, /outcome_export_parse_failed_line_3/);
      assert.equal(await readFile(quarantine.path, "utf8"), `{"intent_id":"intent-3","realiz\n`);
      // The readable prefix is rewritten in place, so the next append starts from clean bytes.
      assert.equal(await readFile(path, "utf8"), good);
    } finally {
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart reopens authoritative sqlite state and keeps the export in step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcome-restart-"));
  const path = join(directory, "trade-outcomes.jsonl");
  try {
    const first = new TradeOutcomeStore(directory);
    await first.load();
    await first.append(outcome(1));
    await first.append(outcome(2));
    await first.replace({ ...outcome(2), realized_pnl_usd: 99 });
    await first.close();

    const second = new TradeOutcomeStore(directory);
    try {
      await second.load();
      assert.deepEqual(second.all().map((row) => row.intent_id), ["intent-1", "intent-2"]);
      assert.equal(second.get("intent-2")?.realized_pnl_usd, 99);
      assert.equal(second.status().export_backlog, 0);
      assert.equal(second.status().feed.integrity, "ok");
      // The rewrite path replaced the export atomically, so no temp file outlived it.
      assert.equal((await readdir(directory)).filter((name) => name.endsWith(".tmp")).length, 0);
      assert.deepEqual(
        (await readLines(path)).map((line) => (JSON.parse(line) as TradeOutcomeV1).realized_pnl_usd),
        [1, 99],
      );
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed export keeps the committed outcome, reports backlog, and heals on the next write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcome-export-fault-"));
  const path = join(directory, "trade-outcomes.jsonl");
  try {
    const store = new TradeOutcomeStore(directory);
    try {
      await store.load();
      // A directory where the export file belongs fails every write with a real errno,
      // the same catch path an ENOSPC or EACCES write takes.
      await mkdir(path);
      await store.append(outcome(1));
      const failed = store.status();
      assert.equal(failed.export_backlog, 1);
      assert.equal(failed.export_failures, 1);
      assert.ok(failed.last_export_error, "export failure was not reported");
      // The authoritative commit stands: the index and sqlite both hold the outcome.
      assert.equal(store.hasIntent("intent-1"), true);
      assert.equal(failed.feed.current_count, 1);

      // The queue is not poisoned: the next append still commits and still reports backlog.
      await store.append(outcome(2));
      assert.equal(store.status().export_backlog, 2);
      assert.equal(store.hasIntent("intent-2"), true);

      await rm(path, { recursive: true });
      await store.append(outcome(3));
      const healed = store.status();
      assert.equal(healed.export_backlog, 0);
      assert.equal(healed.last_export_error, null);
      // Recovery rewrites the whole export, so the outcomes lost by the failed writes return.
      assert.deepEqual(
        (await readLines(path)).map((line) => (JSON.parse(line) as TradeOutcomeV1).intent_id),
        ["intent-1", "intent-2", "intent-3"],
      );
    } finally {
      await store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed ledger write is counted, blocks durability, and does not poison the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledger-fault-"));
  const path = join(directory, "events.jsonl");
  try {
    await mkdir(path);
    const ledger = new JsonlEventStore(directory);
    await assert.rejects(ledger.append(event(1)));
    await assert.rejects(ledger.append(event(2)));
    const failed = ledger.status();
    assert.equal(failed.pending, 0);
    assert.equal(failed.failed_writes, 2);
    assert.equal(failed.consecutive_failures, 2);
    assert.equal(failed.durable, false);
    assert.ok(failed.last_failure_utc);

    await rm(path, { recursive: true });
    await ledger.append(event(3));
    await ledger.waitForIdle();
    const healed = ledger.status();
    assert.equal(healed.durable, true);
    assert.equal(healed.pending, 0);
    assert.equal(healed.last_write_error, null);
    assert.equal(healed.failed_writes, 2);
    assert.deepEqual(
      (await readLines(path)).map((line) => (JSON.parse(line) as LedgerEvent).event_id),
      ["event-3"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes queued behind a failed write still run, in order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledger-order-"));
  const path = join(directory, "events.jsonl");
  try {
    await mkdir(path);
    const ledger = new JsonlEventStore(directory);
    const blocked = [1, 2, 3].map((index) => ledger.append(event(index)));
    assert.equal(ledger.status().pending, 3);
    for (const write of blocked) {
      await assert.rejects(write);
    }
    // Every queued write ran instead of stalling behind the first rejection.
    assert.equal(ledger.status().consecutive_failures, 3);
    assert.equal(ledger.status().pending, 0);

    await rm(path, { recursive: true });
    const recovered = [4, 5, 6].map((index) => ledger.append(event(index)));
    await Promise.all(recovered);
    assert.deepEqual(
      (await readLines(path)).map((line) => (JSON.parse(line) as LedgerEvent).event_id),
      ["event-4", "event-5", "event-6"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
