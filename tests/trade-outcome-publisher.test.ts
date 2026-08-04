import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TradeOutcomePublisher } from "../src/learning/trade-outcome-publisher.js";
import { TRADE_OUTCOME_SCHEMA } from "../src/learning/trade-outcome.js";
import { TradeOutcomeStore } from "../src/storage/trade-outcome-store.js";
import type { TrancheView } from "../src/ownership/tranches.js";
import type { TradeInfo } from "../src/domain/models.js";

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

const instantPublisherOptions = {
  settleMs: 0,
  retrySettleMs: 0,
  searchTailMs: 15_000,
  sleep: async () => undefined,
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
          profitAndLoss: null,
          fees: 1.0,
          side: 0,
          size: 1,
          voided: false,
          orderId: 3353603011,
        }, {
          id: 100,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-03T14:00:00.500Z",
          price: 28620,
          profitAndLoss: 42.5,
          fees: 1.1,
          side: 1,
          size: 1,
          voided: false,
          orderId: 2,
        }];
      },
    },
    store,
    instantPublisherOptions,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-15979101",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [tranche],
    exitUtc: "2026-08-03T14:00:00.000Z",
    tickSize: 0.25,
    tickValue: 0.5,
    maeUsd: 8,
    mfeUsd: 50,
  });

  assert.equal(published.length, 1);
  assert.equal(published[0]?.schema_version, TRADE_OUTCOME_SCHEMA);
  assert.equal(published[0]?.learning_eligible, true);
  assert.equal(published[0]?.realized_pnl_usd, 42.5);
  assert.equal(published[0]?.fees_usd, 2.1);
  assert.equal(published[0]?.exit_reason, "take_profit");
  assert.equal(published[0]?.fills?.length, 2);
  assert.equal(published[0]?.mae_usd, 8);
  assert.equal(published[0]?.mfe_usd, 50);
  assert.equal(published[0]?.side, "long");
  assert.ok((published[0]?.initial_risk_usd ?? 0) > 0);
  assert.ok(published[0]?.r_multiple !== null && published[0]?.r_multiple !== undefined);

  const file = await readFile(join(dir, "trade-outcomes.jsonl"), "utf8");
  assert.match(file, /774b92f8-61a2-5c3a-b68e-e7f722bf1cf0/);

  const second = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-15979101",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [tranche],
    exitUtc: "2026-08-03T14:00:00.000Z",
    maeUsd: 8,
    mfeUsd: 50,
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
    instantPublisherOptions,
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

test("TradeOutcomePublisher includes closing fill that lands after stream flat utc", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  let searches = 0;
  const entry: TradeInfo = {
    id: 2947950983,
    accountId: 1,
    contractId: "CON.F.US.MNQ.U26",
    creationTimestamp: "2026-08-04T19:11:02.461Z",
    price: 29927.25,
    profitAndLoss: null,
    fees: 0.36,
    side: 0,
    size: 1,
    voided: false,
    orderId: 3361993336,
  };
  const exit: TradeInfo = {
    id: 2947956594,
    accountId: 1,
    contractId: "CON.F.US.MNQ.U26",
    creationTimestamp: "2026-08-04T19:12:57.570Z",
    price: 29925.25,
    profitAndLoss: -4,
    fees: 0.86,
    side: 1,
    size: 1,
    voided: false,
    orderId: 3361999999,
  };
  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades(_accountId, _start, end) {
        searches += 1;
        assert.ok(end && end >= "2026-08-04T19:13:11.486Z");
        return [entry, exit];
      },
    },
    store,
    instantPublisherOptions,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-90809185",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [{
      ...tranche,
      intent_id: "a255faad-420b-5049-a8a8-fa2b0a50fd53",
      entry_order_id: 3361993336,
      created_utc: "2026-08-04T19:11:01.193Z",
      protection: {
        status: "proven",
        reason: "ok",
        stop: {
          provider_order_id: 3361993337,
          custom_tag: "glt-a255faad-420b-5049-a8a8-fa2b0a50fd53-SL",
          price: 29908.5,
        },
        target: {
          provider_order_id: 3361993338,
          custom_tag: "glt-a255faad-420b-5049-a8a8-fa2b0a50fd53-TP",
          price: 29948,
        },
      },
    }],
    exitUtc: "2026-08-04T19:12:56.486Z",
  });

  assert.equal(searches, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.realized_pnl_usd, -4);
  assert.equal(published[0]?.fees_usd, 1.22);
  assert.equal(published[0]?.attribution?.trade_count, 2);
  assert.equal(published[0]?.exit_utc, "2026-08-04T19:12:57.570Z");
  assert.equal(published[0]?.learning_eligible, false);
  assert.equal(published[0]?.fills?.length, 2);
});

test("TradeOutcomePublisher replaces incomplete entry-only outcome after richer search", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  let phase = 0;
  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades() {
        phase += 1;
        if (phase === 1) {
          return [{
            id: 1,
            accountId: 1,
            contractId: "CON.F.US.MNQ.U26",
            creationTimestamp: "2026-08-03T13:59:50.000Z",
            price: 28580,
            profitAndLoss: null,
            fees: 0.36,
            side: 0,
            size: 1,
            voided: false,
            orderId: 3353603011,
          }];
        }
        return [{
          id: 1,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-03T13:59:50.000Z",
          price: 28580,
          profitAndLoss: null,
          fees: 0.36,
          side: 0,
          size: 1,
          voided: false,
          orderId: 3353603011,
        }, {
          id: 2,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-03T14:00:01.000Z",
          price: 28570,
          profitAndLoss: -20,
          fees: 0.86,
          side: 1,
          size: 1,
          voided: false,
          orderId: 999,
        }];
      },
    },
    store,
    instantPublisherOptions,
  );

  const first = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [tranche],
    exitUtc: "2026-08-03T14:00:00.000Z",
  });
  assert.equal(first[0]?.realized_pnl_usd, 0);
  assert.equal(first[0]?.attribution?.trade_count, 1);

  const second = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [tranche],
    exitUtc: "2026-08-03T14:00:00.000Z",
  });
  assert.equal(second.length, 1);
  assert.equal(second[0]?.realized_pnl_usd, -20);
  assert.equal(second[0]?.fees_usd, 1.22);
  assert.equal(second[0]?.attribution?.trade_count, 2);

  const rows = (await readFile(join(dir, "trade-outcomes.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/);
  assert.equal(rows.length, 1);
});
