import type { QuoteInfo } from "./models.js";

/** Cognition / band revalidation reference — NT parity (current_price, not bid/ask alone). */
export function resolveDecisionReferencePrice(quote: QuoteInfo | null | undefined): number | null {
  if (!quote) {
    return null;
  }
  const last = quote.lastPrice;
  if (typeof last === "number" && Number.isFinite(last) && last > 0) {
    return last;
  }
  const bid = quote.bestBid;
  const ask = quote.bestAsk;
  if (
    typeof bid === "number"
    && typeof ask === "number"
    && Number.isFinite(bid)
    && Number.isFinite(ask)
    && bid > 0
    && ask > 0
  ) {
    return (bid + ask) / 2;
  }
  if (typeof ask === "number" && Number.isFinite(ask) && ask > 0) {
    return ask;
  }
  if (typeof bid === "number" && Number.isFinite(bid) && bid > 0) {
    return bid;
  }
  return null;
}

/** Bracket submission reference — executable side of the book. */
export function resolveExecutableReferencePrice(
  side: "long" | "short",
  quote: QuoteInfo | null | undefined,
): number | null {
  if (!quote) {
    return null;
  }
  const primary = side === "long" ? quote.bestAsk : quote.bestBid;
  if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  return resolveDecisionReferencePrice(quote);
}

export interface EntryBandGuidance {
  schema_version: "glitch.topstep.entry_band_guidance.v1";
  /** Suggested minimum band width in ticks (not prices). */
  suggested_min_width_ticks: number;
  /** Spread at packet build time in ticks. */
  spread_ticks: number | null;
  notes: string[];
}

export function buildEntryBandGuidance(
  spreadTicks: number | null | undefined,
): EntryBandGuidance {
  const spread = typeof spreadTicks === "number" && Number.isFinite(spreadTicks) && spreadTicks >= 0
    ? spreadTicks
    : 1;
  // ponytail: heuristic min width = spread + 2 ticks drift cushion; upgrade via calibrated drift stats.
  const suggestedMinWidthTicks = Math.max(2, Math.ceil(spread) + 2);
  return {
    schema_version: "glitch.topstep.entry_band_guidance.v1",
    suggested_min_width_ticks: suggestedMinWidthTicks,
    spread_ticks: typeof spreadTicks === "number" && Number.isFinite(spreadTicks) ? spreadTicks : null,
    notes: [
      "Advisory only — Hermes sets entry_price_min/max as the EV-retaining zone, not raw bid/ask.",
      "Band must contain decision reference (last/mid) and price plausible decision-to-delivery drift once.",
    ],
  };
}
