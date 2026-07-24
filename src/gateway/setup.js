function riskTicks(reference, stop, tickSize) {
  return Math.abs(reference - stop) / tickSize;
}

function riskUsd(ticks, tickValue, quantity) {
  return ticks * tickValue * quantity;
}

export function buildSetupCandidates({
  market,
  positionState,
  policy,
  contract,
  protection,
}) {
  if (positionState?.side !== "flat") {
    return [];
  }
  const quantities = [1];
  const last = Number(market.last);
  const bid = Number(market.bid ?? last);
  const ask = Number(market.ask ?? last);
  const tickSize = Number(contract.tickSize) || 0.25;
  const tickValue = Number(contract.tickValue) || 0.5;
  const allowedRisk = Number(policy.allowed_risk_usd) || 50;
  const atr = Number(market.features?.atr_14_1m) || null;
  const levels = market.levels || {};
  const regime = market.features?.regime_1m;
  const candidates = [];

  const longStop = levels.nearest_support ?? market.session?.low;
  const shortStop = levels.nearest_resistance ?? market.session?.high;
  if (longStop != null && Number.isFinite(longStop)) {
    const reference = ask;
    const ticks = riskTicks(reference, longStop, tickSize);
    const risk = riskUsd(ticks, tickValue, 1);
    const target = levels.nearest_resistance ?? reference + (atr ? atr * 2 : ticks * tickSize);
    if (risk <= allowedRisk && longStop < reference && target > reference) {
      candidates.push({
        action: "ENTER_LONG",
        quantity: 1,
        reference_price: reference,
        stop_loss: Number(longStop.toFixed(2)),
        take_profit_1: Number(target.toFixed(2)),
        risk_usd: Number(risk.toFixed(2)),
        rationale: "Structural long: support + admissible stop under allowed risk.",
        regime,
      });
    }
  }
  if (shortStop != null && Number.isFinite(shortStop)) {
    const reference = bid;
    const ticks = riskTicks(reference, shortStop, tickSize);
    const risk = riskUsd(ticks, tickValue, 1);
    const target = levels.nearest_support ?? reference - (atr ? atr * 2 : ticks * tickSize);
    if (risk <= allowedRisk && shortStop > reference && target < reference) {
      candidates.push({
        action: "ENTER_SHORT",
        quantity: 1,
        reference_price: reference,
        stop_loss: Number(shortStop.toFixed(2)),
        take_profit_1: Number(target.toFixed(2)),
        risk_usd: Number(risk.toFixed(2)),
        rationale: "Structural short: resistance + admissible stop under allowed risk.",
        regime,
      });
    }
  }

  if (regime === "chop" && candidates.length) {
    return candidates.map((item) => ({
      ...item,
      confidence_cap: 0.55,
      caution: "Chop regime — prefer NOTHING unless confirmation is strong.",
    }));
  }
  if (policy.daily_loss_remaining_usd != null && policy.daily_loss_remaining_usd <= 0) {
    return [];
  }
  if (protection && !protection.stop_confirmed && candidates.length) {
    return candidates.map((item) => ({
      ...item,
      caution: "Bracket protection not yet verified for prior submissions.",
    }));
  }
  return candidates.slice(0, 2);
}
