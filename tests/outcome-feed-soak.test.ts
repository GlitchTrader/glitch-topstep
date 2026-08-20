import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TradeOutcomeV1 } from "../src/learning/trade-outcome.js";
import { TradeOutcomeStore } from "../src/storage/trade-outcome-store.js";

const TOTAL = 10_001;
const PAGE = 500;

function outcome(index: number): TradeOutcomeV1 {
  return {
    schema_version: "glitch.topstep.trade_outcome.v1",
    outcome_id: `outcome-${index}`,
    intent_id: `intent-${index}`,
    account: "SIM",
    instrument: "MNQ",
    entry_utc: "2026-08-19T12:00:00.000Z",
    exit_utc: "2026-08-19T12:01:00.000Z",
    realized_pnl_usd: index,
    fees_usd: 2,
    learning_eligible: false,
  };
}

test("cursor replay walks more than 10000 revisions without gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outcome-feed-soak-"));
  const store = new TradeOutcomeStore(directory);
  try {
    for (let index = 1; index <= TOTAL; index += 1) {
      await store.append(outcome(index));
    }

    let cursor = 0;
    let seen = 0;
    let pages = 0;
    for (;;) {
      const page = store.revisionPage(cursor, PAGE);
      assert.equal(page.schema_version, "glitch.topstep.outcome_feed.v2");
      assert.equal(page.after_sequence, cursor);
      assert.equal(page.count, page.revisions.length);
      if (page.count === 0) {
        break;
      }
      for (const revision of page.revisions) {
        // A monotonic +1 walk is the gap proof: any hole or repeat fails here.
        seen += 1;
        assert.equal(revision.sequence, seen);
        assert.equal(revision.outcome_id, `outcome-${seen}`);
        assert.equal(revision.revision, 1);
      }
      cursor = page.revisions.at(-1)!.sequence;
      pages += 1;
      assert.ok(pages <= Math.ceil(TOTAL / PAGE) + 1, "replay did not terminate");
    }

    assert.equal(seen, TOTAL);
    assert.equal(cursor, TOTAL);
    assert.equal(store.revisionPage(cursor, PAGE).high_water_sequence, TOTAL);
    assert.deepEqual(store.status().feed, {
      current_count: TOTAL,
      revision_count: TOTAL,
      high_water_sequence: TOTAL,
      integrity: "ok",
      integrity_error: null,
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
