import type { AmendmentSource } from "../release/distributed-contract.js";
import { isTightenOnlyAmendmentSource } from "../release/distributed-contract.js";

export type PositionSide = "long" | "short";

export type AmendmentLeg = "stop" | "target";

export type AmendmentRejectionCode =
  | "stop_would_widen"
  | "stop_widen_exceeds_risk_envelope"
  | "original_risk_envelope_missing"
  | "target_would_widen"
  | "stop_wrong_side_of_market"
  | "target_wrong_side_of_entry"
  | "amendment_current_price_missing"
  | "amendment_market_reference_missing"
  | "amendment_entry_reference_missing";

export interface OriginalRiskEnvelope {
  envelope_id: string;
  max_protected_loss_ticks: number;
  stop_boundary_price: number;
  fees_slippage_reserve_ticks: number;
  scope_identity: string;
  version: number;
}

export interface AmendmentSafetyInput {
  side: PositionSide;
  leg: AmendmentLeg;
  currentPrice: number | null;
  newPrice: number;
  averageEntry: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  source?: AmendmentSource;
  tickSize?: number;
  originalRiskEnvelope?: OriginalRiskEnvelope | null;
}

export type AmendmentSafetyResult =
  | { ok: true; amendment_source: AmendmentSource }
  | { ok: false; code: AmendmentRejectionCode };

export function buildOriginalRiskEnvelope(input: {
  intentId: string;
  side: PositionSide;
  averageEntry: number;
  stopLoss: number;
  tickSize: number;
  feesSlippageReserveTicks?: number;
  scopeIdentity: string;
}): OriginalRiskEnvelope {
  const lossTicks = input.side === "long"
    ? (input.averageEntry - input.stopLoss) / input.tickSize
    : (input.stopLoss - input.averageEntry) / input.tickSize;
  return {
    envelope_id: `${input.intentId}:risk-envelope:v1`,
    max_protected_loss_ticks: Math.max(0, Math.round(lossTicks)),
    stop_boundary_price: input.stopLoss,
    fees_slippage_reserve_ticks: input.feesSlippageReserveTicks ?? 2,
    scope_identity: input.scopeIdentity,
    version: 1,
  };
}

function protectedLossTicks(
  side: PositionSide,
  averageEntry: number,
  stopPrice: number,
  tickSize: number,
): number {
  return side === "long"
    ? (averageEntry - stopPrice) / tickSize
    : (stopPrice - averageEntry) / tickSize;
}

/**
 * Factual execution bounds for MOVE_STOP / MOVE_TP (TS-R4-06, TS-AUTH-02).
 * Automatic sources remain tighten-only; Hermes may widen within the original envelope.
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
    source,
    tickSize,
    originalRiskEnvelope,
  } = input;
  const amendmentSource = source ?? "HERMES_INTENT";

  if (currentPrice === null || !(currentPrice > 0)) {
    return { ok: false, code: "amendment_current_price_missing" };
  }

  if (leg === "stop") {
    const widens = side === "long"
      ? newPrice < currentPrice
      : newPrice > currentPrice;
    if (widens && (source === undefined || isTightenOnlyAmendmentSource(source))) {
      return { ok: false, code: "stop_would_widen" };
    }
    if (widens && source === "HERMES_INTENT") {
      if (!originalRiskEnvelope || averageEntry === null || !(tickSize && tickSize > 0)) {
        return { ok: false, code: "original_risk_envelope_missing" };
      }
      const newLoss = protectedLossTicks(side, averageEntry, newPrice, tickSize);
      const maxAllowed =
        originalRiskEnvelope.max_protected_loss_ticks
        + originalRiskEnvelope.fees_slippage_reserve_ticks;
      if (newLoss > maxAllowed) {
        return { ok: false, code: "stop_widen_exceeds_risk_envelope" };
      }
      const beyondBoundary = side === "long"
        ? newPrice < originalRiskEnvelope.stop_boundary_price
        : newPrice > originalRiskEnvelope.stop_boundary_price;
      if (beyondBoundary) {
        return { ok: false, code: "stop_widen_exceeds_risk_envelope" };
      }
    }
    if (bestBid === null || bestAsk === null) {
      return { ok: false, code: "amendment_market_reference_missing" };
    }
    const marketable = side === "long"
      ? newPrice >= bestAsk
      : newPrice <= bestBid;
    if (marketable) {
      return { ok: false, code: "stop_wrong_side_of_market" };
    }
    return { ok: true, amendment_source: amendmentSource };
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
  return { ok: true, amendment_source: amendmentSource };
}
