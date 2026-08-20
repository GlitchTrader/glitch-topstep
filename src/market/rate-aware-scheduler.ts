/** ProjectX history endpoint budget documented for TS-MULTI-02: 50 requests per 30s window. */
export const PROJECTX_HISTORY_BUDGET = Object.freeze({ requests: 50, windowMs: 30_000 });

export interface RateAwareSchedulerStatus {
  pending: number;
  completed: number;
  failed: number;
  last_started_utc: string | null;
  last_error: string | null;
  window_ms: number;
  budget_per_window: number;
  /** Highest number of starts observed inside any trailing window so far. */
  observed_peak_per_window: number;
  /** Unused budget at that observed peak; negative would mean the provider limit was crossed. */
  headroom_per_window: number;
}

export class RateAwareScheduler {
  private chain: Promise<void> = Promise.resolve();
  private nextStartMs = 0;
  private pending = 0;
  private completed = 0;
  private failed = 0;
  private lastStartedUtc: string | null = null;
  private lastError: string | null = null;
  private observedPeakPerWindow = 0;
  /** ponytail: sampled at start boundaries only; pruned every start so it stays O(budget). */
  private readonly recentStartsMs: number[] = [];
  private readonly intervalMs: number;

  public constructor(
    requestsPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 60) {
      throw new Error("history_requests_per_minute_invalid");
    }
    this.intervalMs = Math.ceil(60_000 / requestsPerMinute);
  }

  public schedule<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.chain = this.chain.catch(() => undefined).then(async () => {
      const delay = Math.max(0, this.nextStartMs - this.now());
      if (delay > 0) {
        await this.sleep(delay);
      }
      const started = this.now();
      this.nextStartMs = started + this.intervalMs;
      this.lastStartedUtc = new Date(started).toISOString();
      this.recordStart(started);
      try {
        const value = await task();
        this.completed += 1;
        this.lastError = null;
        resolveResult(value);
      } catch (error) {
        this.failed += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        rejectResult(error);
      } finally {
        this.pending -= 1;
      }
    });
    return result;
  }

  public async waitForIdle(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  public status(): RateAwareSchedulerStatus {
    return {
      pending: this.pending,
      completed: this.completed,
      failed: this.failed,
      last_started_utc: this.lastStartedUtc,
      last_error: this.lastError,
      window_ms: PROJECTX_HISTORY_BUDGET.windowMs,
      budget_per_window: PROJECTX_HISTORY_BUDGET.requests,
      observed_peak_per_window: this.observedPeakPerWindow,
      headroom_per_window: PROJECTX_HISTORY_BUDGET.requests - this.observedPeakPerWindow,
    };
  }

  private recordStart(startedMs: number): void {
    const windowStart = startedMs - PROJECTX_HISTORY_BUDGET.windowMs;
    while (this.recentStartsMs.length > 0 && this.recentStartsMs[0]! <= windowStart) {
      this.recentStartsMs.shift();
    }
    this.recentStartsMs.push(startedMs);
    this.observedPeakPerWindow = Math.max(this.observedPeakPerWindow, this.recentStartsMs.length);
  }
}

