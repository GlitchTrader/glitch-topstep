import type { QuoteInfo } from "./models.js";

/** BBO is usable for executable timing when bid/ask are positive and not crossed. */
export function isExecutableQuoteGeometry(
  bid: number | null | undefined,
  ask: number | null | undefined,
): boolean {
  if (
    typeof bid !== "number"
    || typeof ask !== "number"
    || !Number.isFinite(bid)
    || !Number.isFinite(ask)
  ) {
    return false;
  }
  return bid > 0 && ask > 0 && bid < ask;
}

export function computeSpreadTicks(
  bid: number | null | undefined,
  ask: number | null | undefined,
  tickSize: number,
): number | null {
  if (!isExecutableQuoteGeometry(bid, ask) || tickSize <= 0) {
    return null;
  }
  return (ask! - bid!) / tickSize;
}

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
  if (isExecutableQuoteGeometry(bid, ask)) {
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
  const bid = quote.bestBid;
  const ask = quote.bestAsk;
  if (!isExecutableQuoteGeometry(bid, ask)) {
    return resolveDecisionReferencePrice(quote);
  }
  const primary = side === "long" ? ask : bid;
  if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  return resolveDecisionReferencePrice(quote);
}

export interface EntryBandGuidance {
  schema_version: "glitch.topstep.entry_band_guidance.v1";
  /** Suggested minimum band width in ticks (not prices); null when quote geometry is unusable. */
  suggested_min_width_ticks: number | null;
  /** Spread at packet build time in ticks; null when crossed or invalid. */
  spread_ticks: number | null;
  notes: string[];
}

export function buildEntryBandGuidance(
  spreadTicks: number | null | undefined,
): EntryBandGuidance {
  const validSpread = typeof spreadTicks === "number"
    && Number.isFinite(spreadTicks)
    && spreadTicks > 0;
  if (!validSpread) {
    return {
      schema_version: "glitch.topstep.entry_band_guidance.v1",
      suggested_min_width_ticks: null,
      spread_ticks: null,
      notes: [
        "Unusable — executable quote geometry invalid, missing, or non-positive spread; do not derive entry band width from this field.",
        "Preserve structural cognition from bars and observation; current-zone entry EV requiring an executable price is UNCERTAIN.",
      ],
    };
  }
  // ponytail: heuristic min width = spread + 2 ticks drift cushion; upgrade via calibrated drift stats.
  const suggestedMinWidthTicks = Math.max(2, Math.ceil(spreadTicks) + 2);
  return {
    schema_version: "glitch.topstep.entry_band_guidance.v1",
    suggested_min_width_ticks: suggestedMinWidthTicks,
    spread_ticks: spreadTicks,
    notes: [
      "Advisory only — Hermes sets entry_price_min/max as the EV-retaining zone, not raw bid/ask.",
      "Band must contain decision reference (last/mid) and price plausible decision-to-delivery drift once.",
    ],
  };
}
