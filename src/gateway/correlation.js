import { normalizeBars } from "./bars.js";

export function pickCorrelationContract(contracts, preferred = "ES") {
  const needle = preferred.toUpperCase();
  const active = (contracts || []).filter((item) => item.activeContract);
  return (
    active.find((item) => item.symbolId?.toUpperCase().includes(`F.US.${needle}`)) ||
    active.find((item) => item.name?.toUpperCase().includes(needle)) ||
    null
  );
}

export function buildCorrelationSummary(primaryBars, correlatedBars, primarySymbol, correlatedSymbol) {
  const left = normalizeBars(primaryBars).slice(-20);
  const right = normalizeBars(correlatedBars).slice(-20);
  const size = Math.min(left.length, right.length);
  if (size < 5) {
    return {
      symbol: correlatedSymbol,
      available: false,
    };
  }
  const leftSlice = left.slice(-size);
  const rightSlice = right.slice(-size);
  const leftReturns = [];
  const rightReturns = [];
  for (let index = 1; index < size; index += 1) {
    leftReturns.push(leftSlice[index].c - leftSlice[index - 1].c);
    rightReturns.push(rightSlice[index].c - rightSlice[index - 1].c);
  }
  const leftMove = leftSlice.at(-1).c - leftSlice[0].c;
  const rightMove = rightSlice.at(-1).c - rightSlice[0].c;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const leftMean = mean(leftReturns);
  const rightMean = mean(rightReturns);
  let numerator = 0;
  let leftVar = 0;
  let rightVar = 0;
  for (let index = 0; index < leftReturns.length; index += 1) {
    const leftDelta = leftReturns[index] - leftMean;
    const rightDelta = rightReturns[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftVar += leftDelta ** 2;
    rightVar += rightDelta ** 2;
  }
  const correlation =
    leftVar > 0 && rightVar > 0 ? numerator / Math.sqrt(leftVar * rightVar) : null;
  const divergence =
    Math.sign(leftMove) !== Math.sign(rightMove) && Math.abs(leftMove) > 0 && Math.abs(rightMove) > 0;

  return {
    symbol: correlatedSymbol,
    available: true,
    primary_symbol: primarySymbol,
    primary_change_pts: Number(leftMove.toFixed(2)),
    correlated_change_pts: Number(rightMove.toFixed(2)),
    return_correlation_20: correlation == null ? null : Number(correlation.toFixed(4)),
    directional_divergence: divergence,
    aligned: !divergence && Math.sign(leftMove) === Math.sign(rightMove),
  };
}
