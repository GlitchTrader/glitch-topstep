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
    decisionLinks: new Map([[
      "774b92f8-61a2-5c3a-b68e-e7f722bf1cf0",
      { packet_id: "packet-1", snapshot_hash: "snap-1" },
    ]]),
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
  assert.equal(published[0]?.packet_id, "packet-1");
  assert.equal(published[0]?.snapshot_hash, "snap-1");

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

test("TradeOutcomePublisher does not attribute later foreign PnL fills into an older tranche", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades() {
        return [{
          id: 1,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T00:01:29.990Z",
          price: 29583.5,
          profitAndLoss: null,
          fees: 0.36,
          side: 0,
          size: 1,
          voided: false,
          orderId: 3375341458,
        }, {
          id: 2,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T00:01:53.776Z",
          price: 29594.25,
          profitAndLoss: 21.5,
          fees: 0.36,
          side: 1,
          size: 1,
          voided: false,
          orderId: 3375341460,
        }, {
          id: 3,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T08:02:17.946Z",
          price: 29598.25,
          profitAndLoss: 5,
          fees: 0.36,
          side: 1,
          size: 1,
          voided: false,
          orderId: 3376774091,
        }, {
          id: 4,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T11:03:46.235Z",
          price: 29636.25,
          profitAndLoss: 22.5,
          fees: 0.36,
          side: 1,
          size: 1,
          voided: false,
          orderId: 3377043621,
        }];
      },
    },
    store,
    instantPublisherOptions,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC-V2-645601-47191819",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [{
      ...tranche,
      intent_id: "00dda083-f4b3-5c18-a931-939b05e54580",
      entry_order_id: 3375341458,
      created_utc: "2026-08-07T00:01:29.767Z",
      protection: {
        status: "proven",
        reason: "ok",
        stop: {
          provider_order_id: 3375341459,
          custom_tag: "sl",
          price: 29576.25,
        },
        target: {
          provider_order_id: 3375341460,
          custom_tag: "tp",
          price: 29594.25,
        },
      },
    }],
    // Simulate a late incomplete retry using "now" as input.exitUtc.
    exitUtc: "2026-08-07T13:00:00.000Z",
    maeUsd: 0,
    mfeUsd: 20.5,
    tickSize: 0.25,
    tickValue: 0.5,
  });

  assert.equal(published.length, 1);
  assert.equal(published[0]?.realized_pnl_usd, 21.5);
  assert.equal(published[0]?.fees_usd, 0.72);
  assert.equal(published[0]?.attribution?.trade_count, 2);
  assert.equal(published[0]?.exit_reason, "take_profit");
});

test("TradeOutcomePublisher replaces contaminated outcome with cleaned attribution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  await store.append({
    schema_version: TRADE_OUTCOME_SCHEMA,
    outcome_id: "outcome:00dda083-f4b3-5c18-a931-939b05e54580",
    intent_id: "00dda083-f4b3-5c18-a931-939b05e54580",
    account: "PRAC",
    instrument: "MNQ",
    entry_utc: "2026-08-07T00:01:29.767Z",
    exit_utc: "2026-08-07T00:01:53.776Z",
    realized_pnl_usd: 71,
    fees_usd: 1.8,
    learning_eligible: false,
    exit_reason: "unknown",
    attribution: {
      entry_order_id: 3375341458,
      trade_count: 5,
      protection_status: "unknown",
    },
    fills: [
      {
        price: 1, size: 1, side: 0, order_id: 3375341458, timestamp: "2026-08-07T00:01:29.990Z",
        profit_and_loss: null, fees: 0.36,
      },
      {
        price: 1, size: 1, side: 1, order_id: 10, timestamp: "2026-08-07T00:01:53.776Z",
        profit_and_loss: 21.5, fees: 0.36,
      },
      {
        price: 1, size: 1, side: 1, order_id: 11, timestamp: "2026-08-07T08:02:17.946Z",
        profit_and_loss: 5, fees: 0.36,
      },
      {
        price: 1, size: 1, side: 1, order_id: 12, timestamp: "2026-08-07T10:29:46.024Z",
        profit_and_loss: 22, fees: 0.36,
      },
      {
        price: 1, size: 1, side: 1, order_id: 13, timestamp: "2026-08-07T11:03:46.235Z",
        profit_and_loss: 22.5, fees: 0.36,
      },
    ],
    protection_confirmed: false,
  });

  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades() {
        return [{
          id: 1,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T00:01:29.990Z",
          price: 29583.5,
          profitAndLoss: null,
          fees: 0.36,
          side: 0,
          size: 1,
          voided: false,
          orderId: 3375341458,
        }, {
          id: 2,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T00:01:53.776Z",
          price: 29594.25,
          profitAndLoss: 21.5,
          fees: 0.36,
          side: 1,
          size: 1,
          voided: false,
          orderId: 3375341460,
        }];
      },
    },
    store,
    instantPublisherOptions,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [{
      ...tranche,
      intent_id: "00dda083-f4b3-5c18-a931-939b05e54580",
      entry_order_id: 3375341458,
      created_utc: "2026-08-07T00:01:29.767Z",
      protection: {
        status: "proven",
        reason: "ok",
        stop: { provider_order_id: 3375341459, custom_tag: "sl", price: 29576.25 },
        target: { provider_order_id: 3375341460, custom_tag: "tp", price: 29594.25 },
      },
    }],
    exitUtc: "2026-08-07T13:00:00.000Z",
    maeUsd: 0,
    mfeUsd: 20.5,
    tickSize: 0.25,
    tickValue: 0.5,
  });

  assert.equal(published.length, 1);
  assert.equal(published[0]?.realized_pnl_usd, 21.5);
  assert.equal(published[0]?.attribution?.trade_count, 2);
  assert.equal(published[0]?.learning_eligible, true);
});

test("TradeOutcomePublisher does not double-claim one closing fill across two tranches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gt-outcomes-"));
  const store = new TradeOutcomeStore(dir);
  const sharedClose: TradeInfo = {
    id: 300,
    accountId: 1,
    contractId: "CON.F.US.MNQ.U26",
    creationTimestamp: "2026-08-07T11:03:46.235Z",
    price: 29636.25,
    profitAndLoss: 22.5,
    fees: 0.36,
    side: 1,
    size: 1,
    voided: false,
    orderId: 3377043621,
  };
  const publisher = new TradeOutcomePublisher(
    {
      async searchTrades() {
        return [{
          id: 100,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T10:25:48.768Z",
          price: 29609.5,
          profitAndLoss: null,
          fees: 0.36,
          side: 0,
          size: 1,
          voided: false,
          orderId: 3376991175,
        }, {
          id: 200,
          accountId: 1,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-08-07T11:02:24.299Z",
          price: 29625,
          profitAndLoss: null,
          fees: 0.36,
          side: 0,
          size: 1,
          voided: false,
          orderId: 3377043619,
        }, sharedClose];
      },
    },
    store,
    instantPublisherOptions,
  );

  const published = await publisher.publishClosedTranches({
    accountId: 1,
    accountName: "PRAC",
    contractId: "CON.F.US.MNQ.U26",
    instrument: "MNQ",
    tranches: [{
      ...tranche,
      intent_id: "d3f1e460-fed4-5ca2-8eee-6b6486860973",
      entry_order_id: 3376991175,
      created_utc: "2026-08-07T10:25:48.651Z",
      filled_qty: 1,
      protection: {
        status: "pending",
        reason: "target_missing",
        stop: { provider_order_id: null, custom_tag: "sl", price: null },
        target: { provider_order_id: null, custom_tag: "tp", price: null },
      },
    }, {
      ...tranche,
      intent_id: "3749b135-fad3-504a-b7d7-779b73707bd0",
      entry_order_id: 3377043619,
      created_utc: "2026-08-07T11:02:24.201Z",
      filled_qty: 1,
      protection: {
        status: "pending",
        reason: "target_missing",
        stop: { provider_order_id: null, custom_tag: "sl", price: 29618.25 },
        target: { provider_order_id: null, custom_tag: "tp", price: null },
      },
    }],
    exitUtc: "2026-08-07T11:03:46.235Z",
  });

  assert.equal(published.length, 2);
  const withClose = published.filter((row) => (row.evidence?.order_ids ?? []).includes(3377043621));
  assert.equal(withClose.length, 1);
  assert.equal(withClose[0]?.realized_pnl_usd, 22.5);
  const withoutClose = published.find((row) => !(row.evidence?.order_ids ?? []).includes(3377043621));
  assert.ok(withoutClose);
  assert.equal(withoutClose?.realized_pnl_usd, 0);
});
