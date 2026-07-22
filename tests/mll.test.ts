import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateLiquidationFloor, calculateRiskBudget } from "../src/risk/mll.js";
import type { TopstepPolicyState } from "../src/domain/models.js";

function policy(overrides: Partial<TopstepPolicyState> = {}): TopstepPolicyState {
  return {
    program: "xfa",
    accountSize: 50_000,
    initialMaxLoss: 2_000,
    highestEndOfDayBalance: 0,
    mllLockedAtZero: false,
    payoutProcessed: false,
    maxContracts: 5,
    maxDailyRiskUsd: 200,
    dailyRealizedPnlUsd: 0,
    entryWindowOpen: true,
    ...overrides,
  };
}

describe("Topstep maximum loss model", () => {
  it("starts an XFA at the negative loss allowance", () => {
    assert.equal(calculateLiquidationFloor(policy()), -2_000);
  });

  it("trails an XFA floor toward zero from the highest end-of-day balance", () => {
    assert.equal(calculateLiquidationFloor(policy({ highestEndOfDayBalance: 1_250 })), -750);
    assert.equal(calculateLiquidationFloor(policy({ highestEndOfDayBalance: 3_000 })), 0);
  });

  it("locks the floor at zero after the configured lock or payout", () => {
    assert.equal(calculateLiquidationFloor(policy({ mllLockedAtZero: true })), 0);
    assert.equal(calculateLiquidationFloor(policy({ payoutProcessed: true })), 0);
  });

  it("models a combine floor from starting balance and end-of-day gains", () => {
    const combine = policy({
      program: "combine",
      accountSize: 50_000,
      highestEndOfDayBalance: 51_000,
    });
    assert.equal(calculateLiquidationFloor(combine), 49_000);
  });

  it("limits risk by both buffer fraction and remaining daily risk", () => {
    const result = calculateRiskBudget(1_000, policy({ maxDailyRiskUsd: 75 }), 0.04);
    assert.equal(result.currentBuffer, 3_000);
    assert.equal(result.riskFractionBudget, 120);
    assert.equal(result.allowedRiskUsd, 75);
  });
});
