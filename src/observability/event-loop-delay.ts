import { monitorEventLoopDelay } from "node:perf_hooks";

/** Derived from the runtime return so CI @types/node (Node 22) need not export the name. */
type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/**
 * Observe-only event-loop delay for /health (Passo 1 before evidence-writer offload).
 * Histogram is nanoseconds from Node; we expose milliseconds.
 */
export interface EventLoopDelayMetrics {
  /** Resolution of the underlying histogram, ms. */
  resolution_ms: number;
  min_ms: number;
  max_ms: number;
  mean_ms: number;
  p50_ms: number;
  p99_ms: number;
}

function nsToMs(ns: number): number {
  if (!Number.isFinite(ns) || ns <= 0) {
    return 0;
  }
  return Math.round(ns / 1e6);
}

export class EventLoopDelayMonitor {
  private readonly histogram: IntervalHistogram;
  private readonly resolutionMs: number;
  private enabled = false;

  public constructor(resolutionMs = 20) {
    this.resolutionMs = resolutionMs;
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  }

  public enable(): void {
    if (this.enabled) {
      return;
    }
    this.histogram.enable();
    this.enabled = true;
  }

  public disable(): void {
    if (!this.enabled) {
      return;
    }
    this.histogram.disable();
    this.enabled = false;
  }

  /**
   * Snapshot current histogram. When reset=true (authenticated /health), the next window
   * starts clean so soak samples correlate with the interval since the previous poll.
   * Liveness peeks use reset=false so a stalled auth poll still leaves the stall visible.
   */
  public snapshot(options: { reset?: boolean } = {}): EventLoopDelayMetrics {
    const metrics: EventLoopDelayMetrics = {
      resolution_ms: this.resolutionMs,
      min_ms: nsToMs(this.histogram.min),
      max_ms: nsToMs(this.histogram.max),
      mean_ms: nsToMs(this.histogram.mean),
      p50_ms: nsToMs(this.histogram.percentile(50)),
      p99_ms: nsToMs(this.histogram.percentile(99)),
    };
    if (options.reset) {
      this.histogram.reset();
    }
    return metrics;
  }
}
