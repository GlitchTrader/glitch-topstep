import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  RiskSettings,
  TopstepPolicyState,
  TradeIntent,
} from "../src/domain/models.js";
import { RiskRejectedError, validateEntryRisk } from "../src/risk/risk-engine.js";
import { snapshot } from "./fixtures.js";

const policy: TopstepPolicyState = {
  accountStage: "express_funded_standard",
  lossModel: "express_funded_eod",
  authority: "operator_configured",
  verifiedAtUtc: null,
  startingBalance: 50_000,
  initialMaximumLoss: 2_000,
  highestEndOfDayBalance: 0,
  lossFloorLockedAtZero: false,
  payoutProcessed: false,
  operatorProvidedLossFloorUsd: null,
  maxContracts: 3,
};

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

function intent(): TradeIntent {
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
    promptVersion: "glitch-topstep-v2",
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
    quantity: 1,
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
  now: new Date("2026-07-21T12:00:05Z"),
};

describe("factual execution safety", () => {
  it("computes protected risk without applying an arbitrary percentage budget", () => {
    const result = validateEntryRisk(intent(), snapshot(), policy, settings, context);
    assert.equal(result.riskUsd, 43.5);
    assert.equal(result.riskBudget.currentBuffer, 3_000);
  });

  it("reserves fees and slippage for every contract", () => {
    const value = intent();
    value.quantity = 2;
    const result = validateEntryRisk(value, snapshot(), policy, settings, context);
    assert.equal(result.riskUsd, 87);
  });

  it("rejects only a protected loss that reaches the hard loss floor", () => {
    const value = intent();
    value.stopLoss = 18_490.25;
    assert.throws(
      () => validateEntryRisk(value, snapshot(), policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "hard_loss_floor_breach",
    );
  });

  it("rejects hard contract capacity but not the account simulation class", () => {
    const oversized = intent();
    oversized.quantity = 4;
    assert.throws(
      () => validateEntryRisk(oversized, snapshot(), policy, settings, context),
      /hard_contract_capacity_exceeded/,
    );

    const live = snapshot();
    live.account.simulated = false;
    assert.doesNotThrow(() => validateEntryRisk(intent(), live, policy, settings, context));
  });

  it("rejects stale or incomplete venue truth", () => {
    const stale = snapshot();
    stale.capturedAt = "2026-07-21T11:59:00Z";
    assert.throws(
      () => validateEntryRisk(intent(), stale, policy, settings, context),
      /account_state_stale/,
    );

    const incomplete = snapshot();
    incomplete.stateComplete = false;
    incomplete.stateIssues = ["market_stream_reconnecting"];
    assert.throws(
      () => validateEntryRisk(intent(), incomplete, policy, settings, context),
      /venue_state_incomplete/,
    );
  });
});
