/**
 * Observe-only lag from evidence enqueue to onDurable/apply.
 * Authenticated /health snapshots and resets, same windowing as event_loop_delay.
 * min/max/last/count are exact. p99 is exact while the class sample count stays
 * under the cap.
 * ponytail: reservoir after MAX_SAMPLES per class (~4 min at the TS-R2-07 rate,
 * ~50s at a 5x burst). Past the cap, p99 is a sample and max stays exact.
 * Upgrade path is an HDR histogram if a health window regularly exceeds the cap.
 */
const MAX_SAMPLES = 32_768;
const CLASSES = ["identity", "quote", "depth", "print"] as const;
type ApplyLagClass = (typeof CLASSES)[number];

export interface ApplyLagClassMetrics {
  min_ms: number;
  max_ms: number;
  p99_ms: number;
  last_ms: number;
  count: number;
}

export type ApplyLagMetrics = Record<ApplyLagClass, ApplyLagClassMetrics>;

const ZERO_CLASS: ApplyLagClassMetrics = {
  min_ms: 0,
  max_ms: 0,
  p99_ms: 0,
  last_ms: 0,
  count: 0,
};

export class ApplyLagTracker {
  private readonly samples: Record<ApplyLagClass, number[]> = {
    identity: [],
    quote: [],
    depth: [],
    print: [],
  };
  private readonly min = emptyNumbers();
  private readonly max = emptyNumbers();
  private readonly last = emptyNumbers();
  private readonly count = emptyNumbers();

  public observe(eventClass: ApplyLagClass, lagMs: number): void {
    const ms = Math.max(0, Math.round(lagMs));
    const seen = this.count[eventClass];
    const bucket = this.samples[eventClass];
    if (seen < MAX_SAMPLES) {
      bucket.push(ms);
    } else {
      const slot = Math.floor(Math.random() * (seen + 1));
      if (slot < MAX_SAMPLES) {
        bucket[slot] = ms;
      }
    }
    this.count[eventClass] = seen + 1;
    this.last[eventClass] = ms;
    if (seen === 0 || ms < this.min[eventClass]) {
      this.min[eventClass] = ms;
    }
    if (ms > this.max[eventClass]) {
      this.max[eventClass] = ms;
    }
  }

  /** reset=true on authenticated /health so the next poll is a fresh window. */
  public snapshot(options: { reset?: boolean } = {}): ApplyLagMetrics {
    const metrics = {
      identity: this.classMetrics("identity"),
      quote: this.classMetrics("quote"),
      depth: this.classMetrics("depth"),
      print: this.classMetrics("print"),
    };
    if (options.reset) {
      this.reset();
    }
    return metrics;
  }

  private classMetrics(eventClass: ApplyLagClass): ApplyLagClassMetrics {
    const count = this.count[eventClass];
    if (count === 0) {
      return { ...ZERO_CLASS };
    }
    return {
      min_ms: this.min[eventClass],
      max_ms: this.max[eventClass],
      p99_ms: percentileNearestRank(this.samples[eventClass], 0.99),
      last_ms: this.last[eventClass],
      count,
    };
  }

  private reset(): void {
    for (const eventClass of CLASSES) {
      this.samples[eventClass] = [];
      this.min[eventClass] = 0;
      this.max[eventClass] = 0;
      this.last[eventClass] = 0;
      this.count[eventClass] = 0;
    }
  }
}

function emptyNumbers(): Record<ApplyLagClass, number> {
  return { identity: 0, quote: 0, depth: 0, print: 0 };
}

/** Nearest-rank percentile. `samples` is the exact window, or a reservoir past the cap. */
function percentileNearestRank(samples: readonly number[], rank: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index] ?? 0;
}
