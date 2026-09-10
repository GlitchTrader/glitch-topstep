/**
 * Quote BBO incompleteness is a payload-quality fault, not a SignalR stream gap.
 * Must not bump operational.generation or fake market_stream reconnect invalidation.
 */

import type { SanitizedQuoteEventDiagnostic } from "./quote-reject-diagnostics.js";

export const QUOTE_BBO_INCOMPLETE = "quote_bbo_incomplete";

export function isQuoteBboIncompleteError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message === QUOTE_BBO_INCOMPLETE;
  }
  return String(error ?? "") === QUOTE_BBO_INCOMPLETE;
}

export function contractIdFromQuoteRawPayload(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== "object") {
    return null;
  }
  const contractId = (rawPayload as { contractId?: unknown }).contractId;
  return typeof contractId === "string" && contractId.length > 0 ? contractId : null;
}

export function diagnosticFromQuoteError(error: unknown): SanitizedQuoteEventDiagnostic | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
  if (!diagnostic || typeof diagnostic !== "object") {
    return null;
  }
  return diagnostic as SanitizedQuoteEventDiagnostic;
}

/** Bounded stderr telemetry — one line per window, with suppressed count. */
export class RateLimitedQuoteBboIncompleteLog {
  private lastLogMs = 0;
  private suppressed = 0;
  private total = 0;

  constructor(
    private readonly windowMs: number = 5_000,
    private readonly now: () => number = Date.now,
    private readonly write: (line: string, error: unknown) => void = (line, error) => {
      console.error(line, error);
    },
  ) {}

  record(
    error: unknown,
    diagnostic?: SanitizedQuoteEventDiagnostic | null,
  ): { emitted: boolean; total: number; suppressed: number } {
    this.total += 1;
    const now = this.now();
    const due = this.lastLogMs === 0 || now - this.lastLogMs >= this.windowMs;
    if (due) {
      const diag = diagnostic ?? diagnosticFromQuoteError(error);
      const diagPart = diag
        ? ` kind=${diag.snapshot_or_partial}`
          + ` bid=${diag.bid_presence} ask=${diag.ask_presence} last=${diag.last_presence}`
          + ` contract=${diag.contract_id ?? "null"}`
          + ` gen=${diag.reconnect_generation}`
          + ` hash=${diag.structural_hash}`
          + ` ts=${diag.last_updated ?? diag.timestamp ?? "null"}`
          + ` seq=${diag.sequence_or_update_id ?? "none"}`
        : "";
      const line =
        `Rejected ProjectX realtime quote (${QUOTE_BBO_INCOMPLETE}) `
        + `total=${this.total} suppressed_since_last_log=${this.suppressed}`
        + diagPart;
      this.write(line, error);
      this.lastLogMs = now;
      this.suppressed = 0;
      return { emitted: true, total: this.total, suppressed: 0 };
    }
    this.suppressed += 1;
    return { emitted: false, total: this.total, suppressed: this.suppressed };
  }

  snapshot(): { total: number; suppressed: number; lastLogMs: number } {
    return {
      total: this.total,
      suppressed: this.suppressed,
      lastLogMs: this.lastLogMs,
    };
  }
}
