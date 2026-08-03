import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TradeOutcomePublisher } from "../src/learning/trade-outcome-publisher.js";
import { TRADE_OUTCOME_SCHEMA } from "../src/learning/trade-outcome.js";
import { TradeOutcomeStore } from "../src/storage/trade-outcome-store.js";
import type { TrancheView } from "../src/ownership/tranches.js";

const tranche: TrancheView = {
  intent_id: "774b92f8-61a2-5c3a-b68e-e7f722bf1cf0",
  entry_order_id: 3353603011,
  filled_qty: 1,
  remaining_qty: 1,
  created_utc: "2026-08-03T13:57:08.000Z",
  protection: {
    status: "proven",
    reason: "ok",
    stop: { provider_order_id: 1, custom_tag: "stop", price: 28507.5 },
    target: { provider_order_id: 2, custom_tag: "target", price: 28620 },
  },
};

test("TradeOutcomePublisher writes canonical learning-eligible outcome on flat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades() {
        return [{
          id: 99,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-03T13:59:50.000Z",
          price: 28580,
          profitAndLoss: 42.5,
          fees: 2.1,
          side: 1,
          size: 1,
          voided: false,
          orderId: 3353603011,
        }];
      },
    },
    store,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-15979101",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [tranche],
    exitUtc: "2026-08-03T14:00:00.000Z",
  });

  assert.equal(published.length, 1);
  assert.equal(published[0]?.schema_version, TRADE_OUTCOME_SCHEMA);
  assert.equal(published[0]?.learning_eligible, true);
  assert.equal(published[0]?.realized_pnl_usd, 42.5);
  assert.equal(published[0]?.fees_usd, 2.1);

  const file = await readFile(join(dir, "trade-outcomes.jsonl"), "utf8");
  assert.match(file, /774b92f8-61a2-5c3a-b68e-e7f722bf1cf0/);

  const second = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-15979101",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [tranche],
    exitUtc: "2026-08-03T14:00:00.000Z",
  });
  assert.equal(second.length, 0);
});

test("TradeOutcomePublisher marks learning ineligible without proven protection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades() {
        return [];
      },
    },
    store,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-15979101",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [{
      ...tranche,
      protection: { ...tranche.protection, status: "unknown" },
    }],
    exitUtc: "2026-08-03T14:00:00.000Z",
  });

  assert.equal(published[0]?.learning_eligible, false);
});
