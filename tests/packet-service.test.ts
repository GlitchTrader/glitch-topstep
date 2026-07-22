import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { AccountVenueSnapshot } from "../src/domain/models.js";
import { DecisionPacketService } from "../src/hermes/packet-service.js";

function config(): AppConfig {
  return {
    projectX: {
      username: "user",
      apiKey: "key",
      apiUrl: "https://api.topstepx.com",
      userHubUrl: "https://rtc.topstepx.com/hubs/user",
      marketHubUrl: "https://rtc.topstepx.com/hubs/market",
    },
    scope: {
      accountId: 1,
      accountName: "SIM",
      contractId: "MNQ",
      instrument: "MNQ",
      liveMarketData: false,
    },
    localGateway: { host: "127.0.0.1", port: 8790, token: "012345678901234567890123" },
    tradingMode: "shadow",
    requireSimulatedAccount: true,
    policy: {
      program: "xfa",
      accountSize: 50_000,
      initialMaxLoss: 2_000,
      highestEndOfDayBalance: 0,
      mllLockedAtZero: false,
      payoutProcessed: false,
      maxContracts: 1,
      maxDailyRiskUsd: 100,
      dailyRealizedPnlUsd: 0,
      entryWindowOpen: true,
    },
    risk: {
      maxRiskFractionOfBuffer: 0.04,
      estimatedRoundTurnFeesUsd: 2.5,
      slippageReserveTicks: 2,
      maxQuoteAgeMs: 5_000,
      maxStateAgeMs: 5_000,
      maxIntentAgeMs: 60_000,
    },
    dataDir: "./data",
    reconcileIntervalMs: 3_000,
    packetLeaseMs: 60_000,
  };
}

function snapshot(): AccountVenueSnapshot {
  return {
    capturedAt: "2026-07-21T12:00:00Z",
    account: {
      id: 1,
      name: "SIM",
      balance: 1_000,
      canTrade: true,
      isVisible: true,
      simulated: true,
    },
    contract: {
      id: "MNQ",
      name: "MNQ",
      description: "MNQ",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    },
    quote: {
      contractId: "MNQ",
      symbol: "F.US.MNQ",
      lastPrice: 20_000,
      bestBid: 19_999.75,
      bestAsk: 20_000.25,
      open: 19_950,
      high: 20_020,
      low: 19_930,
      volume: 1_000,
      timestamp: "2026-07-21T12:00:00Z",
    },
    positions: [],
    openOrders: [],
    totalOpenContracts: 0,
    instrumentOpenContracts: 0,
    unrealizedPnl: 0,
    conservativeEquity: 1_000,
    stateComplete: true,
  };
}

describe("decision packet lease", () => {
  it("keeps the issued packet stable while live state changes inside the lease", () => {
    let now = 1_000;
    const current = snapshot();
    const service = new DecisionPacketService(config(), () => current, () => now);
    const first = service.current();
    current.quote = { ...current.quote!, bestAsk: 20_001.25, timestamp: "2026-07-21T12:00:01Z" };
    const second = service.current();
    assert.equal(second.packet_id, first.packet_id);
    assert.equal(second.market.snapshot_hash, first.market.snapshot_hash);

    now += 60_001;
    const third = service.current();
    assert.notEqual(third.packet_id, first.packet_id);
    assert.notEqual(third.market.snapshot_hash, first.market.snapshot_hash);
  });
});
