/**
 * Interval covered by one authenticated /health sample.
 * Watchdog and soak sampler both reset the same counters, so the gap between
 * resets is not always the watchdog's 2 minutes. Liveness reads without moving
 * the start.
 */
export interface ObservationWindowMetrics {
  window_start_utc: string;
  window_ms: number;
}

export class ObservationWindow {
  private startMs: number;

  public constructor(private readonly now: () => number = Date.now) {
    this.startMs = this.now();
  }

  public snapshot(options: { reset?: boolean } = {}): ObservationWindowMetrics {
    const now = this.now();
    const metrics: ObservationWindowMetrics = {
      window_start_utc: new Date(this.startMs).toISOString(),
      window_ms: Math.max(0, now - this.startMs),
    };
    if (options.reset) {
      this.startMs = now;
    }
    return metrics;
  }
}
