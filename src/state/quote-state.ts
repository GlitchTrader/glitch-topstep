import type { AccountVenueSnapshot } from "../domain/models.js";

/** Explicit Topstep quote geometry classification — not a silent rewrite of provider data. */
export type QuoteState = "normal" | "locked" | "invalid";

/** Whether ProjectX mutations (place/modify/close) may proceed from quote geometry alone. */
export type ExecutionEligibility =
  | "eligible"
  | "blocked_locked"
  | "blocked_invalid"
  | "blocked_incomplete";

export type QuoteStateReason =
  | "normal"
  | "locked_bbo"
  | "crossed_bbo"
  | "nonfinite_bbo"
  | "nonpositive_bbo"
  | "missing_bbo";

export interface QuoteClassification {
  quote_state: QuoteState;
  reason_codes: QuoteStateReason[];
  /**
   * True when non-geometry venue/state issues are empty.
   * Locked/invalid geometry is tracked via quote_state, not as "incomplete data".
   */
  data_completeness: boolean;
  execution_eligibility: ExecutionEligibility;
  best_bid: number | null;
  best_ask: number | null;
  last: number | null;
}

/**
 * Classify BBO without fabricating missing sides.
 * - normal: bestBid < bestAsk (both finite positive)
 * - locked: bestBid === bestAsk
 * - invalid: missing, nonfinite, nonpositive, or crossed
 */
export function classifyQuoteState(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
): { quote_state: QuoteState; reason_codes: QuoteStateReason[] } {
  if (bestBid == null || bestAsk == null) {
    return { quote_state: "invalid", reason_codes: ["missing_bbo"] };
  }
  const reasons: QuoteStateReason[] = [];
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    reasons.push("nonfinite_bbo");
  }
  if (!(bestBid > 0) || !(bestAsk > 0)) {
    reasons.push("nonpositive_bbo");
  }
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > bestAsk) {
    reasons.push("crossed_bbo");
  }
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid === bestAsk) {
    reasons.push("locked_bbo");
  }
  if (reasons.length === 0) {
    return { quote_state: "normal", reason_codes: ["normal"] };
  }
  if (reasons.length === 1 && reasons[0] === "locked_bbo") {
    return { quote_state: "locked", reason_codes: reasons };
  }
  return { quote_state: "invalid", reason_codes: reasons };
}

/** Issue codes that are pure quote-geometry (not stream/recon completeness). */
export const QUOTE_GEOMETRY_ISSUE_CODES = new Set([
  "quote_locked",
  "quote_geometry_invalid",
  "quote_missing",
]);

export function isQuoteGeometryIssue(code: string): boolean {
  return QUOTE_GEOMETRY_ISSUE_CODES.has(code);
}

export function issueCodeForQuoteState(quoteState: QuoteState): string | null {
  if (quoteState === "locked") return "quote_locked";
  if (quoteState === "invalid") return "quote_geometry_invalid";
  return null;
}

export function deriveExecutionEligibility(
  quoteState: QuoteState,
  dataCompleteness: boolean,
): ExecutionEligibility {
  if (quoteState === "locked") return "blocked_locked";
  if (quoteState === "invalid") return "blocked_invalid";
  if (!dataCompleteness) return "blocked_incomplete";
  return "eligible";
}

export function buildQuoteClassification(
  snapshot: AccountVenueSnapshot,
  nonGeometryIssues: Iterable<string>,
): QuoteClassification {
  const quote = snapshot.quote;
  const classified = quote
    ? classifyQuoteState(quote.bestBid, quote.bestAsk)
    : { quote_state: "invalid" as const, reason_codes: ["missing_bbo" as const] };

  const completenessIssues = [...nonGeometryIssues].filter((code) => !isQuoteGeometryIssue(code));
  // Missing quote is incomplete AND invalid.
  const data_completeness = quote !== null && completenessIssues.length === 0;

  return {
    quote_state: classified.quote_state,
    reason_codes: classified.reason_codes,
    data_completeness,
    execution_eligibility: deriveExecutionEligibility(classified.quote_state, data_completeness),
    best_bid: quote && Number.isFinite(quote.bestBid) ? quote.bestBid : null,
    best_ask: quote && Number.isFinite(quote.bestAsk) ? quote.bestAsk : null,
    last: quote && Number.isFinite(quote.lastPrice) ? quote.lastPrice : null,
  };
}
