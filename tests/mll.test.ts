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
  it("starts an Express Funded account one maximum loss below the starting balance", () => {
    assert.equal(calculateLiquidationFloor(policy()), 48_000);
  });

  it("trails the Express Funded floor toward breakeven from highest EOD balance", () => {
    assert.equal(calculateLiquidationFloor(policy({ highestEndOfDayBalance: 1_250 })), 49_250);
    assert.equal(calculateLiquidationFloor(policy({ highestEndOfDayBalance: 3_000 })), 50_000);
  });

  it("locks the floor at breakeven after the configured lock or payout", () => {
    assert.equal(calculateLiquidationFloor(policy({ lossFloorLockedAtZero: true })), 50_000);
    assert.equal(calculateLiquidationFloor(policy({ payoutProcessed: true })), 50_000);
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
    const result = calculateRiskBudget(51_000, policy());
    assert.equal(result.liquidationFloor, 48_000);
    assert.equal(result.currentBuffer, 3_000);
    assert.equal("allowedRiskUsd" in result, false);
    assert.equal("riskFractionBudget" in result, false);
  });

  it("expresses every loss model in the absolute frame of conservative equity", () => {
    // Regression guard: conservativeEquity is a ProjectX account balance plus
    // unrealized PnL. A floor returned relative to the starting balance would
    // overstate headroom by roughly the starting balance and effectively disable
    // the hard_loss_floor_breach rejection.
    const untouchedEquity = 50_000;
    for (const model of ["express_funded_eod", "trading_combine_eod"] as const) {
      const budget = calculateRiskBudget(untouchedEquity, policy({ lossModel: model }));
      assert.equal(
        budget.currentBuffer,
        2_000,
        `${model} must report one maximum-loss allowance of headroom at the starting balance`,
      );
    }
  });

  it("reports zero headroom once conservative equity reaches the floor", () => {
    const budget = calculateRiskBudget(48_000, policy());
    assert.equal(budget.currentBuffer, 0);
  });
});
