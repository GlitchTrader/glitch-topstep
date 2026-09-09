/**
 * Quote BBO incompleteness is a payload-quality fault, not a SignalR stream gap.
 * Must not bump operational.generation or fake market_stream reconnect invalidation.
 */

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

  record(error: unknown): { emitted: boolean; total: number; suppressed: number } {
    this.total += 1;
    const now = this.now();
    const due = this.lastLogMs === 0 || now - this.lastLogMs >= this.windowMs;
    if (due) {
      const line =
        `Rejected ProjectX realtime quote (${QUOTE_BBO_INCOMPLETE}) `
        + `total=${this.total} suppressed_since_last_log=${this.suppressed}`;
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
