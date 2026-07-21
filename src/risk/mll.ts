import type { RiskBudget, TopstepPolicyState } from "../domain/models.js";

export function calculateLiquidationFloor(policy: TopstepPolicyState): number {
  if (policy.mllLockedAtZero || policy.payoutProcessed) {
    return 0;
  }

  if (policy.program === "combine") {
    const baseFloor = policy.accountSize - policy.initialMaxLoss;
    const trailingGain = Math.max(0, policy.highestEndOfDayBalance - policy.accountSize);
    return Math.min(policy.accountSize, baseFloor + trailingGain);
  }

  const xfaFloor = -policy.initialMaxLoss + Math.max(0, policy.highestEndOfDayBalance);
  return Math.min(0, xfaFloor);
}

export function calculateRiskBudget(
  conservativeEquity: number,
  policy: TopstepPolicyState,
  maxRiskFractionOfBuffer: number,
): RiskBudget {
  const liquidationFloor = calculateLiquidationFloor(policy);
  const currentBuffer = Math.max(0, conservativeEquity - liquidationFloor);
  const riskFractionBudget = currentBuffer * maxRiskFractionOfBuffer;
  const realizedLossToday = Math.max(0, -policy.dailyRealizedPnlUsd);
  const dailyRiskRemaining = Math.max(0, policy.maxDailyRiskUsd - realizedLossToday);
  const allowedRiskUsd = Math.max(0, Math.min(riskFractionBudget, dailyRiskRemaining));

  return {
    liquidationFloor,
    currentBuffer,
    riskFractionBudget,
    dailyRiskRemaining,
    allowedRiskUsd,
  };
}
