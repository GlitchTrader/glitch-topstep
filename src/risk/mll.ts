import type { RiskBudget, TopstepPolicyState } from "../domain/models.js";

export function calculateLiquidationFloor(policy: TopstepPolicyState): number {
  if (policy.lossModel === "operator_provided_floor") {
    if (policy.operatorProvidedLossFloorUsd === null || !Number.isFinite(policy.operatorProvidedLossFloorUsd)) {
      throw new Error("operator_provided_loss_floor_missing");
    }
    return policy.operatorProvidedLossFloorUsd;
  }

  if (policy.lossFloorLockedAtZero || policy.payoutProcessed) {
    return 0;
  }

  if (policy.lossModel === "trading_combine_eod") {
    const baseFloor = policy.startingBalance - policy.initialMaximumLoss;
    const trailingGain = Math.max(0, policy.highestEndOfDayBalance - policy.startingBalance);
    return Math.min(policy.startingBalance, baseFloor + trailingGain);
  }

  const expressFundedFloor = -policy.initialMaximumLoss + Math.max(0, policy.highestEndOfDayBalance);
  return Math.min(0, expressFundedFloor);
}

export function calculateRiskBudget(
  conservativeEquity: number,
  policy: TopstepPolicyState,
): RiskBudget {
  const liquidationFloor = calculateLiquidationFloor(policy);
  const currentBuffer = Math.max(0, conservativeEquity - liquidationFloor);
  return { liquidationFloor, currentBuffer };
}
