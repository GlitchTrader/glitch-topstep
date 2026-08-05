export type PositionSide = "long" | "short";

export type AmendmentLeg = "stop" | "target";

export type AmendmentRejectionCode =
  | "stop_would_widen"
  | "target_would_widen"
  | "stop_wrong_side_of_market"
  | "target_wrong_side_of_entry"
  | "amendment_current_price_missing"
  | "amendment_market_reference_missing"
  | "amendment_entry_reference_missing";

export interface AmendmentSafetyInput {
  side: PositionSide;
  leg: AmendmentLeg;
  currentPrice: number | null;
  newPrice: number;
  averageEntry: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

export type AmendmentSafetyResult =
  | { ok: true }
  | { ok: false; code: AmendmentRejectionCode };

/**
 * Factual execution bounds for MOVE_STOP / MOVE_TP (TS-R4-06).
 * Tightening only; no cognition vetoes.
 */
export function validateProtectiveAmendment(input: AmendmentSafetyInput): AmendmentSafetyResult {
  const {
    side,
    leg,
    currentPrice,
    newPrice,
    averageEntry,
    bestBid,
    bestAsk,
  } = input;

  if (currentPrice === null || !(currentPrice > 0)) {
    return { ok: false, code: "amendment_current_price_missing" };
  }

  if (leg === "stop") {
    const widens = side === "long"
      ? newPrice < currentPrice
      : newPrice > currentPrice;
    if (widens) {
      return { ok: false, code: "stop_would_widen" };
    }
    if (bestBid === null || bestAsk === null) {
      return { ok: false, code: "amendment_market_reference_missing" };
    }
    // ponytail: reject marketable-side stops (breakeven at/inside spread still allowed).
    const marketable = side === "long"
      ? newPrice >= bestAsk
      : newPrice <= bestBid;
    if (marketable) {
      return { ok: false, code: "stop_wrong_side_of_market" };
    }
    return { ok: true };
  }

  const worsens = side === "long"
    ? newPrice < currentPrice
    : newPrice > currentPrice;
  if (worsens) {
    return { ok: false, code: "target_would_widen" };
  }
  if (averageEntry === null || !(averageEntry > 0)) {
    return { ok: false, code: "amendment_entry_reference_missing" };
  }
  const wrongSide = side === "long"
    ? newPrice <= averageEntry
    : newPrice >= averageEntry;
  if (wrongSide) {
    return { ok: false, code: "target_wrong_side_of_entry" };
  }
  return { ok: true };
}
