import type { AccountVenueSnapshot, VenueOperationalStatus } from "../src/domain/models.js";

export function operational(): VenueOperationalStatus {
  return {
    generation: 1,
    userStream: {
      state: "connected",
      generation: 1,
      lastChangedAt: "2026-07-21T12:00:00Z",
      lastEventAt: "2026-07-21T12:00:04Z",
      lastError: null,
    },
    marketStream: {
      state: "connected",
      generation: 1,
      lastChangedAt: "2026-07-21T12:00:00Z",
      lastEventAt: "2026-07-21T12:00:04Z",
      lastError: null,
    },
    reconciliation: {
      state: "succeeded",
      generation: 1,
      lastStartedAt: "2026-07-21T12:00:03Z",
      lastSucceededAt: "2026-07-21T12:00:04Z",
      lastError: null,
    },
  };
}

export function snapshot(): AccountVenueSnapshot {
  return {
    capturedAt: "2026-07-21T12:00:04Z",
    account: {
      id: 101,
      name: "TEST_ACCOUNT",
      balance: 1_000,
      canTrade: true,
      isVisible: true,
      simulated: true,
    },
    contract: {
      id: "CON.F.US.MNQ.U26",
      name: "MNQU6",
      description: "Micro E-mini Nasdaq",
      tickSize: 0.25,
      tickValue: 0.5,
      activeContract: true,
      symbolId: "F.US.MNQ",
    },
    quote: {
      contractId: "CON.F.US.MNQ.U26",
      symbol: "F.US.MNQ",
      lastPrice: 20_000,
      bestBid: 19_999.75,
      bestAsk: 20_000.25,
      open: 19_950,
      high: 20_020,
      low: 19_930,
      volume: 10_000,
      timestamp: "2026-07-21T12:00:04Z",
    },
    positions: [],
    openOrders: [],
    totalOpenContracts: 0,
    instrumentOpenContracts: 0,
    unrealizedPnl: 0,
    conservativeEquity: 1_000,
    operational: operational(),
    stateIssues: [],
    stateComplete: true,
  };
}
