import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VenueStateStore } from "../src/state/venue-state.js";

const stamp = "2026-07-21T12:00:00Z";

function readyState(): VenueStateStore {
  const state = new VenueStateStore();
  state.registerContracts([{
    id: "MNQ",
    name: "MNQ",
    description: "MNQ",
    tickSize: 0.25,
    tickValue: 0.5,
    activeContract: true,
    symbolId: "F.US.MNQ",
  }]);
  state.replaceAccounts([{
    id: 1,
    name: "SIM",
    balance: 100,
    canTrade: true,
    isVisible: true,
  }], stamp);
  state.replacePositions([{
    id: 2,
    accountId: 1,
    contractId: "MNQ",
    creationTimestamp: stamp,
    type: 1,
    size: 2,
    averagePrice: 20_000,
  }], stamp);
  state.replaceOrders([], stamp);
  state.markStreamConnected("user", stamp);
  state.markStreamConnected("market", stamp);
  state.applyQuote({
    contractId: "MNQ",
    symbol: "F.US.MNQ",
    lastPrice: 20_010.25,
    bestBid: 20_010,
    bestAsk: 20_010.25,
    open: 20_000,
    high: 20_020,
    low: 19_990,
    volume: 1_000,
    timestamp: stamp,
  }, stamp);
  state.markStreamEvent("user", stamp);
  state.markStreamEvent("market", stamp);
  state.markReconciliationStarted(stamp);
  state.markReconciliationSucceeded(stamp);
  return state;
}

describe("venue state truth", () => {
  it("computes conservative PnL only when streams and reconciliation agree", () => {
    const snapshot = readyState().buildSnapshot(1, "MNQ");
    assert.equal(snapshot.unrealizedPnl, 40);
    assert.equal(snapshot.conservativeEquity, 140);
    assert.equal(snapshot.stateComplete, true);
    assert.deepEqual(snapshot.stateIssues, []);
  });

  it("invalidates completeness during reconnect until current reconciliation lands", () => {
    const state = readyState();
    state.markStreamReconnecting("market", new Error("lost"));
    let snapshot = state.buildSnapshot(1, "MNQ");
    assert.equal(snapshot.stateComplete, false);
    assert.ok(snapshot.stateIssues.includes("market_stream_reconnecting"));

    state.markStreamConnected("market");
    state.markStreamEvent("market");
    snapshot = state.buildSnapshot(1, "MNQ");
    assert.ok(snapshot.stateIssues.includes("reconciliation_not_current"));

    state.markReconciliationStarted();
    state.markReconciliationSucceeded();
    assert.equal(state.buildSnapshot(1, "MNQ").stateComplete, true);
  });

  it("makes malformed payload state visible instead of silently ignoring it", () => {
    const state = readyState();
    state.markPayloadFault("user", new Error("contract mismatch"));
    const snapshot = state.buildSnapshot(1, "MNQ");
    assert.equal(snapshot.stateComplete, false);
    assert.equal(snapshot.operational.userStream.state, "degraded");
    assert.match(snapshot.operational.userStream.lastError ?? "", /contract mismatch/);
  });

  it("never assumes zero PnL for another open account position", () => {
    const state = readyState();
    state.registerContracts([{
      id: "MES",
      name: "MES",
      description: "MES",
      tickSize: 0.25,
      tickValue: 1.25,
      activeContract: true,
      symbolId: "F.US.MES",
    }]);
    state.replacePositions([
      {
        id: 2,
        accountId: 1,
        contractId: "MNQ",
        creationTimestamp: stamp,
        type: 1,
        size: 2,
        averagePrice: 20_000,
      },
      {
        id: 3,
        accountId: 1,
        contractId: "MES",
        creationTimestamp: stamp,
        type: 2,
        size: 1,
        averagePrice: 5_000,
      },
    ], stamp);

    let snapshot = state.buildSnapshot(1, "MNQ");
    assert.equal(snapshot.stateComplete, false);
    assert.ok(snapshot.stateIssues.includes("position_quote_missing:MES"));
    assert.equal(snapshot.unrealizedPnl, 40);

    state.applyQuote({
      contractId: "MES",
      symbol: "F.US.MES",
      lastPrice: 5_000.75,
      bestBid: 5_000.5,
      bestAsk: 5_001,
      open: 4_990,
      high: 5_010,
      low: 4_980,
      volume: 2_000,
      timestamp: stamp,
    }, stamp);
    snapshot = state.buildSnapshot(1, "MNQ");
    assert.equal(snapshot.stateComplete, true);
    assert.equal(snapshot.unrealizedPnl, 35);
    assert.equal(snapshot.conservativeEquity, 135);
  });
});
