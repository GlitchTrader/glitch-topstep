import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AccountVenueSnapshot,
  RiskSettings,
  TopstepPolicyState,
  TradeIntent,
} from "../src/domain/models.js";
import { RiskRejectedError, validateEntryRisk } from "../src/risk/risk-engine.js";

const now = new Date("2026-07-21T12:00:05Z");

function snapshot(): AccountVenueSnapshot {
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
    stateComplete: true,
  };
}

function policy(): TopstepPolicyState {
  return {
    program: "xfa",
    accountSize: 50_000,
    initialMaxLoss: 2_000,
    highestEndOfDayBalance: 0,
    mllLockedAtZero: false,
    payoutProcessed: false,
    maxContracts: 3,
    maxDailyRiskUsd: 200,
    dailyRealizedPnlUsd: 0,
    entryWindowOpen: true,
  };
}

function settings(): RiskSettings {
  return {
    maxRiskFractionOfBuffer: 0.04,
    estimatedRoundTurnFeesUsd: 2.5,
    slippageReserveTicks: 2,
    maxQuoteAgeMs: 5_000,
    maxStateAgeMs: 5_000,
    maxIntentAgeMs: 60_000,
  };
}

function intent(quantity = 1): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: "00000000-0000-4000-8000-000000000001",
    createdUtc: "2026-07-21T12:00:04Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action: "ENTER_LONG",
    confidence: 0.6,
    snapshotHash: "hash",
    modelVersion: "test",
    promptVersion: "test-v1",
    reason: "Test entry.",
    decisionAudit: {
      bullCase: "Bull.",
      bearCase: "Bear.",
      flatCase: "Flat.",
      aggressiveCase: "Aggressive.",
      conservativeCase: "Conservative.",
      decisiveEvidence: "Evidence.",
      disconfirmingEvidence: "Counter.",
      changeCondition: "Change.",
      finalChoice: "ENTER_LONG",
    },
    quantity,
    orderType: "MARKET",
    stopLoss: 19_980.25,
    takeProfit1: 20_030.25,
  };
}

const context = {
  expectedAccountId: 101,
  expectedAccountName: "TEST_ACCOUNT",
  expectedInstrument: "MNQ",
  expectedSnapshotHash: "hash",
  requireSimulatedAccount: true,
  now,
};

describe("deterministic entry risk", () => {
  it("accepts a protected entry inside the stop-aware buffer budget", () => {
    const result = validateEntryRisk(intent(1), snapshot(), policy(), settings(), context);
    assert.equal(result.riskUsd, 43.5);
    assert.equal(result.stopTicks, 80);
    assert.equal(result.targetTicks, 120);
  });

  it("rejects quantity whose stop-aware risk exceeds the account budget", () => {
    assert.throws(
      () => validateEntryRisk(intent(3), snapshot(), policy(), settings(), context),
      /risk_budget_exceeded/,
    );
  });

  it("rejects live accounts when the configured scope requires simulation", () => {
    const value = snapshot();
    value.account.simulated = false;
    assert.throws(
      () => validateEntryRisk(intent(), value, policy(), settings(), context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "simulated_account_required",
    );
  });

  it("rejects stale state and crossed identity", () => {
    const stale = snapshot();
    stale.capturedAt = "2026-07-21T11:59:00Z";
    assert.throws(
      () => validateEntryRisk(intent(), stale, policy(), settings(), context),
      /account_state_stale/,
    );
    assert.throws(
      () => validateEntryRisk(
        { ...intent(), account: "WRONG" },
        snapshot(),
        policy(),
        settings(),
        context,
      ),
      /account_name_mismatch/,
    );
  });
});
