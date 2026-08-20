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
    promptVersion: "glitch-topstep-v10",
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

  it("prices protected risk from the submitted bracket, not the requested stop level", () => {
    // An off-tick reference price forces stopTicks to round away from the stop,
    // so the account bears more risk than the requested stop level implies.
    const offTick = snapshot();
    offTick.quote = { ...offTick.quote!, bestAsk: 20_000.3 };
    const result = validateEntryRisk(intent(), offTick, policy, settings, context);

    assert.equal(result.stopTicks, 81);
    // 81 ticks * $0.50 + 2 slippage ticks * $0.50 + $2.50 fees.
    assert.equal(result.riskUsd, 44);
    const requestedStopRisk = Math.abs(20_000.3 - 19_980.25) * 2 + 1 + 2.5;
    assert.ok(
      result.riskUsd > requestedStopRisk,
      "submitted-bracket risk must never understate the requested-stop estimate",
    );
  });

  it("rejects a decision older than the configured intent age", () => {
    const stale = intent();
    stale.createdUtc = "2026-07-21T11:50:05Z";
    assert.throws(
      () => validateEntryRisk(stale, snapshot(), policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "intent_stale",
    );

    const malformed = intent();
    malformed.createdUtc = "not-a-timestamp";
    assert.throws(
      () => validateEntryRisk(malformed, snapshot(), policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "intent_timestamp_invalid",
    );
  });

  it("allows same-direction scale-in when only protective orders remain open", () => {
    const positioned = snapshot();
    positioned.instrumentOpenContracts = 1;
    positioned.totalOpenContracts = 1;
    positioned.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      type: 2,
      size: 1,
      averagePrice: 20_000,
    }];
    positioned.openOrders = [{
      id: 9201,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 4,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: 20_010,
      customTag: "glt-00000000-0000-4000-8000-00000000a001-SL",
    }, {
      id: 9202,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 1,
      side: 0,
      size: 1,
      limitPrice: 19_980,
      stopPrice: null,
      customTag: "glt-00000000-0000-4000-8000-00000000a001-TP",
    }];
    const shortIntent = intent();
    shortIntent.action = "ENTER_SHORT";
    shortIntent.decisionAudit.finalChoice = "ENTER_SHORT";
    shortIntent.stopLoss = 20_010.25;
    shortIntent.takeProfit1 = 19_980.25;
    assert.doesNotThrow(() => validateEntryRisk(shortIntent, positioned, policy, settings, context));

    const longIntent = intent();
    assert.throws(
      () => validateEntryRisk(longIntent, positioned, policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "position_side_conflict",
    );
  });

  it("rejects scale-in when non-protective working orders remain", () => {
    const positioned = snapshot();
    positioned.instrumentOpenContracts = 1;
    positioned.totalOpenContracts = 1;
    positioned.positions = [{
      id: 1,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      type: 1,
      size: 1,
      averagePrice: 20_000,
    }];
    positioned.openOrders = [{
      id: 9301,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      creationTimestamp: "2026-07-21T12:00:08Z",
      updateTimestamp: "2026-07-21T12:00:09Z",
      status: 1,
      type: 2,
      side: 0,
      size: 1,
      limitPrice: null,
      stopPrice: null,
      customTag: "glt-pending-entry",
    }];
    assert.throws(
      () => validateEntryRisk(intent(), positioned, policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "working_order_ownership_unresolved",
    );
  });

  it("rejects stale or incomplete venue truth", () => {
    const stale = snapshot();
    stale.capturedAt = "2026-07-21T11:59:00Z";
    stale.operational.reconciliation.lastSucceededAt = "2026-07-21T11:59:00Z";
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

