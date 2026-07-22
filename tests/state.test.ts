import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VenueStateStore } from "../src/state/venue-state.js";

describe("venue state store", () => {
  it("computes conservative unrealized PnL from executable bid/ask marks", () => {
    const state = new VenueStateStore();
    const stamp = "2026-07-21T12:00:00Z";
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
      simulated: true,
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

    const snapshot = state.buildSnapshot(1, "MNQ");
    assert.equal(snapshot.unrealizedPnl, 40);
    assert.equal(snapshot.conservativeEquity, 140);
    assert.equal(snapshot.stateComplete, true);
  });
});
