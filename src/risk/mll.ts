import type { RiskBudget, TopstepPolicyState } from "../domain/models.js";

/**
 * Trailing Topstep loss floors are naturally expressed relative to the starting
 * balance (0 means "back to breakeven", -D means "down the full allowance").
 * `conservativeEquity` is an absolute account figure (ProjectX balance plus
 * unrealized PnL), so a relative floor must be converted before the two are
 * compared. Returning a relative floor to an absolute consumer silently
 * overstates hard headroom by roughly the starting balance.
 */
function trailingFloorRelativeToStart(policy: TopstepPolicyState): number {
  if (policy.lossFloorLockedAtZero || policy.payoutProcessed) {
    return 0;
  }

  if (policy.lossModel === "trading_combine_eod") {
    const trailingGain = Math.max(0, policy.highestEndOfDayBalance - policy.startingBalance);
    return Math.min(0, -policy.initialMaximumLoss + trailingGain);
  }

  return Math.min(0, -policy.initialMaximumLoss + Math.max(0, policy.highestEndOfDayBalance));
}

/**
 * Returns the hard liquidation floor in the same absolute frame as
 * `conservativeEquity`.
 */
export function calculateLiquidationFloor(policy: TopstepPolicyState): number {
  if (policy.lossModel === "operator_provided_floor") {
    if (policy.operatorProvidedLossFloorUsd === null || !Number.isFinite(policy.operatorProvidedLossFloorUsd)) {
      throw new Error("operator_provided_loss_floor_missing");
    }
    return policy.operatorProvidedLossFloorUsd;
  }

  return policy.startingBalance + trailingFloorRelativeToStart(policy);
}

export function calculateRiskBudget(
  conservativeEquity: number,
  policy: TopstepPolicyState,
): RiskBudget {
  const liquidationFloor = calculateLiquidationFloor(policy);
  const currentBuffer = Math.max(0, conservativeEquity - liquidationFloor);
  return { liquidationFloor, currentBuffer };
}
