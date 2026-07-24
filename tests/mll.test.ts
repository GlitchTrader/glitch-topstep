import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateLiquidationFloor, calculateRiskBudget } from "../src/risk/mll.js";
import type { TopstepPolicyState } from "../src/domain/models.js";

function policy(overrides: Partial<TopstepPolicyState> = {}): TopstepPolicyState {
  return {
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
    maxContracts: 5,
    ...overrides,
  };
}

describe("Topstep hard loss-floor model", () => {
  it("starts an Express Funded account at the negative maximum loss", () => {
    assert.equal(calculateLiquidationFloor(policy()), -2_000);
  });

  it("trails the Express Funded floor toward zero from highest EOD balance", () => {
    assert.equal(calculateLiquidationFloor(policy({ highestEndOfDayBalance: 1_250 })), -750);
    assert.equal(calculateLiquidationFloor(policy({ highestEndOfDayBalance: 3_000 })), 0);
  });

  it("locks the floor at zero after the configured lock or payout", () => {
    assert.equal(calculateLiquidationFloor(policy({ lossFloorLockedAtZero: true })), 0);
    assert.equal(calculateLiquidationFloor(policy({ payoutProcessed: true })), 0);
  });

  it("models a Trading Combine floor from starting balance and EOD gains", () => {
    const combine = policy({
      lossModel: "trading_combine_eod",
      startingBalance: 50_000,
      highestEndOfDayBalance: 51_000,
    });
    assert.equal(calculateLiquidationFloor(combine), 49_000);
  });

  it("supports an explicit provider or operator reconciled hard floor", () => {
    assert.equal(calculateLiquidationFloor(policy({
      lossModel: "operator_provided_floor",
      operatorProvidedLossFloorUsd: 48_250,
    })), 48_250);
  });

  it("reports the full hard-floor headroom without inventing a strategy budget", () => {
    const result = calculateRiskBudget(1_000, policy());
    assert.equal(result.liquidationFloor, -2_000);
    assert.equal(result.currentBuffer, 3_000);
    assert.equal("allowedRiskUsd" in result, false);
    assert.equal("riskFractionBudget" in result, false);
  });
});
