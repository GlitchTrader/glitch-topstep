import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TradeOutcomeV1 } from "../src/learning/trade-outcome.js";
import { SqliteOutcomeFeed } from "../src/storage/sqlite-outcome-feed.js";

function outcome(pnl: number): TradeOutcomeV1 {
  return {
    schema_version: "glitch.topstep.trade_outcome.v1",
    outcome_id: "outcome-1",
    intent_id: "intent-1",
    account: "SIM",
    instrument: "MCL",
    entry_utc: "2026-08-19T12:00:00.000Z",
    exit_utc: "2026-08-19T12:01:00.000Z",
    realized_pnl_usd: pnl,
    fees_usd: 2,
    learning_eligible: false,
  } as TradeOutcomeV1;
}

test("revisioned outcome feed preserves corrections and cursor replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcome-feed-"));
  const feed = new SqliteOutcomeFeed(join(directory, "feed.sqlite"));
  try {
    const first = feed.publish(outcome(10), "provisional", "2026-08-19T12:01:01.000Z");
    const second = feed.publish(outcome(12), "corrected", "2026-08-19T12:01:02.000Z");
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(feed.current()[0]?.realized_pnl_usd, 12);
    const page = feed.afterSequence(first.sequence, 100);
    assert.equal(page.count, 1);
    assert.equal(page.revisions[0]?.revision, 2);
    assert.equal(page.high_water_sequence, second.sequence);
  } finally {
    feed.close();
    await rm(directory, { recursive: true, force: true });
  }
});

