import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RiskSettings, TopstepPolicyState, TradeIntent } from "../src/domain/models.js";
import {
  evaluateSnapshotDataQuality,
  newExposureBlockCode,
  resetQuoteGeometryTelemetryRetentionForTest,
} from "../src/state/data-quality.js";
import { actionAllowedForQuote, classifyQuoteState } from "../src/state/quote-state.js";
import { RiskRejectedError, validateEntryRisk } from "../src/risk/risk-engine.js";
import { snapshot } from "./fixtures.js";

const settings: RiskSettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

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
    promptVersion: "glitch-topstep-v17.1",
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

afterEach(() => {
  resetQuoteGeometryTelemetryRetentionForTest();
});

describe("quote_state × action matrix", () => {
  const actions = [
    "new_exposure",
    "risk_increasing_amendment",
    "exit_reduction",
    "flatten",
    "protective_action",
    "recovery",
  ] as const;

  it("documents permitted/blocked matrix for normal/locked/invalid", () => {
    const cases: Array<{
      label: string;
      eligibility: "eligible" | "blocked_locked" | "blocked_invalid" | "blocked_incomplete";
      expected: Record<(typeof actions)[number], boolean>;
    }> = [
      {
        label: "normal",
        eligibility: "eligible",
        expected: {
          new_exposure: true,
          risk_increasing_amendment: true,
          exit_reduction: true,
          flatten: true,
          protective_action: true,
          recovery: true,
        },
      },
      {
        label: "locked",
        eligibility: "blocked_locked",
        expected: {
          new_exposure: false,
          risk_increasing_amendment: false,
          exit_reduction: true,
          flatten: true,
          protective_action: true,
          recovery: true,
        },
      },
      {
        label: "invalid",
        eligibility: "blocked_invalid",
        expected: {
          new_exposure: false,
          risk_increasing_amendment: false,
          exit_reduction: true,
          flatten: true,
          protective_action: true,
          recovery: true,
        },
      },
      {
        label: "stale/incomplete",
        eligibility: "blocked_incomplete",
        expected: {
          new_exposure: false,
          risk_increasing_amendment: false,
          exit_reduction: true,
          flatten: true,
          protective_action: true,
          recovery: true,
        },
      },
    ];

    for (const row of cases) {
      for (const action of actions) {
        assert.equal(
          actionAllowedForQuote(action, row.eligibility),
          row.expected[action],
          `${row.label}/${action}`,
        );
      }
    }
  });

  it("blocks new exposure entry on locked and invalid", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 20000, bestAsk: 20000 };
    assert.throws(
      () => validateEntryRisk(intent(), locked, policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "quote_locked",
    );

    const crossed = snapshot();
    crossed.quote = { ...crossed.quote!, bestBid: 20100, bestAsk: 20000 };
    assert.throws(
      () => validateEntryRisk(intent(), crossed, policy, settings, context),
      (error: unknown) => error instanceof RiskRejectedError && error.code === "quote_geometry_invalid",
    );
  });

  it("newExposureBlockCode blocks increase but risk_reduction_eligibility stays eligible", () => {
    for (const [bid, ask, block] of [
      [20000, 20000, "quote_locked"],
      [20100, 20000, "quote_geometry_invalid"],
    ] as const) {
      const current = snapshot();
      current.quote = { ...current.quote!, bestBid: bid, bestAsk: ask };
      const quality = evaluateSnapshotDataQuality(current, settings, new Date("2026-07-21T12:00:05Z"));
      assert.equal(newExposureBlockCode(quality), block);
      assert.equal(quality.riskReductionEligibility, "eligible");
      assert.equal(actionAllowedForQuote("exit_reduction", quality.executionEligibility), true);
      assert.equal(actionAllowedForQuote("flatten", quality.executionEligibility), true);
      assert.equal(actionAllowedForQuote("protective_action", quality.executionEligibility), true);
      assert.equal(actionAllowedForQuote("recovery", quality.executionEligibility), true);
      assert.equal(actionAllowedForQuote("new_exposure", quality.executionEligibility), false);
    }
  });

  it("data_completeness true on locked is not execution authorization", () => {
    const locked = snapshot();
    locked.quote = { ...locked.quote!, bestBid: 29456, bestAsk: 29456 };
    const quality = evaluateSnapshotDataQuality(locked, settings, new Date("2026-07-21T12:00:05Z"));
    assert.equal(quality.dataCompleteness, true);
    assert.equal(quality.executionEligibility, "blocked_locked");
    assert.equal(newExposureBlockCode(quality), "quote_locked");
  });

  it("stale quote blocks new exposure via execution_eligibility but not risk reduction matrix", () => {
    const stale = snapshot();
    stale.quote = { ...stale.quote!, timestamp: "2026-07-21T11:59:00Z" };
    stale.operational.reconciliation.lastSucceededAt = "2026-07-21T12:00:04Z";
    const quality = evaluateSnapshotDataQuality(stale, settings, new Date("2026-07-21T12:00:10Z"));
    assert.ok(quality.issues.includes("quote_stale"));
    assert.equal(quality.executionEligibility, "blocked_incomplete");
    assert.equal(quality.riskReductionEligibility, "eligible");
    assert.equal(actionAllowedForQuote("new_exposure", quality.executionEligibility), false);
    assert.equal(actionAllowedForQuote("flatten", quality.executionEligibility), true);
  });
});

describe("classifyQuoteState sanity", () => {
  it("keeps locked distinct from invalid", () => {
    assert.equal(classifyQuoteState(100, 100).quote_state, "locked");
    assert.equal(classifyQuoteState(101, 100).quote_state, "invalid");
  });
});
