import assert from "node:assert/strict";
import test from "node:test";
import {
  entryAndExitPrices,
  inferExitReason,
  inferSideFromFills,
  rMultiple,
  structuralRiskUsd,
  toOutcomeFills,
} from "../src/learning/trade-outcome-enrichment.js";
import { TradeExcursionTracker } from "../src/learning/trade-excursion-tracker.js";
import type { TradeInfo } from "../src/domain/models.js";

const entry: TradeInfo = {
  id: 1,
  accountId: 1,
  contractId: "CON.F.US.MNQ.U26",
  creationTimestamp: "2026-08-04T19:11:02.000Z",
  price: 29927.25,
  profitAndLoss: null,
  fees: 0.36,
  side: 0,
  size: 1,
  voided: false,
  orderId: 100,
};

const exitStop: TradeInfo = {
  id: 2,
  accountId: 1,
  contractId: "CON.F.US.MNQ.U26",
  creationTimestamp: "2026-08-04T19:12:57.000Z",
  price: 29908.5,
  profitAndLoss: -37.5,
  fees: 0.36,
  side: 1,
  size: 1,
  voided: false,
  orderId: 200,
};

test("enrichment maps fills, side, prices, and stop exit reason", () => {
  const fills = toOutcomeFills([exitStop, entry]);
  assert.equal(fills[0]?.order_id, 100);
  assert.equal(inferSideFromFills([entry, exitStop], 100), "long");
  assert.deepEqual(entryAndExitPrices([entry, exitStop], 100), {
    entry_price: 29927.25,
    exit_price: 29908.5,
  });
  assert.equal(inferExitReason({
    closingOrderId: 200,
    stopOrderId: 200,
    targetOrderId: 300,
    entryOrderId: 100,
    trigger: "stream",
    hadExitIntent: false,
  }), "stop_loss");
});

test("inferExitReason uses submitted EXIT intent as manual_exit", () => {
  assert.equal(inferExitReason({
    closingOrderId: 999,
    stopOrderId: 200,
    targetOrderId: 300,
    entryOrderId: 100,
    trigger: "stream",
    hadExitIntent: true,
  }), "manual_exit");
});

test("structural risk and R-multiple for long MNQ geometry", () => {
  // 29927.25 - 29908.5 = 18.75 points; MNQ $2/point → $37.50 risk
  const risk = structuralRiskUsd({
    side: "long",
    entryPrice: 29927.25,
    stopPrice: 29908.5,
    quantity: 1,
    tickSize: 0.25,
    tickValue: 0.5,
  });
  assert.equal(risk, 37.5);
  assert.equal(rMultiple(-37.5, risk), -1);
});

test("TradeExcursionTracker records MAE/MFE magnitudes", () => {
  const tracker = new TradeExcursionTracker();
  assert.equal(tracker.excursionUsd(), null);
  tracker.observe(1, 0);
  tracker.observe(1, 5);
  tracker.observe(1, -3);
  tracker.observe(1, 2);
  assert.deepEqual(tracker.excursionUsd(), { mfe_usd: 5, mae_usd: 3 });
});
