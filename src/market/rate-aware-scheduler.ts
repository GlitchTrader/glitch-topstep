/** ProjectX history endpoint budget documented for TS-MULTI-02: 50 requests per 30s window. */
export const PROJECTX_HISTORY_BUDGET = Object.freeze({ requests: 50, windowMs: 30_000 });

/** TS-MULTI-02 acceptance floor: never plan more than budget minus this headroom. */
export const PROJECTX_HISTORY_MIN_HEADROOM = 20;

export type HistorySchedulePriority = "background" | "packet";

export interface HistoryScheduleOptions {
  minHeadroom?: number;
  priority?: HistorySchedulePriority;
}

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
  /** Starts currently counted inside the trailing provider window. */
  window_count: number;
}

/**
 * Global sliding-window token bucket for ProjectX retrieveBars.
 * Parallel schedule() calls may run concurrently while window headroom allows.
 */
export class RateAwareScheduler {
  private pending = 0;
  private completed = 0;
  private failed = 0;
  private lastStartedUtc: string | null = null;
  private lastError: string | null = null;
  private observedPeakPerWindow = 0;
  /** ponytail: pruned on every acquire/status read; O(budget). */
  private readonly recentStartsMs: number[] = [];

  public constructor(
    /** ponytail: retained for config compatibility; throttling uses PROJECTX_HISTORY_BUDGET. */
    _requestsPerMinute = 30,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (!Number.isInteger(_requestsPerMinute) || _requestsPerMinute < 1 || _requestsPerMinute > 60) {
      throw new Error("history_requests_per_minute_invalid");
    }
  }

  public windowCount(atMs: number = this.now()): number {
    this.prune(atMs);
    return this.recentStartsMs.length;
  }

  public canSchedule(
    additionalStarts: number,
    minHeadroom: number = PROJECTX_HISTORY_MIN_HEADROOM,
  ): boolean {
    return this.windowCount() + additionalStarts <= PROJECTX_HISTORY_BUDGET.requests - minHeadroom;
  }

  public projectedPeak(additionalStarts: number): number {
    return Math.max(this.observedPeakPerWindow, this.windowCount() + additionalStarts);
  }

  public schedule<T>(
    task: () => Promise<T>,
    options: HistoryScheduleOptions = {},
  ): Promise<T> {
    const minHeadroom = options.minHeadroom ?? PROJECTX_HISTORY_MIN_HEADROOM;
    this.pending += 1;
    const run = async (): Promise<T> => {
      await this.acquire(minHeadroom);
      try {
        const value = await task();
        this.completed += 1;
        this.lastError = null;
        return value;
      } catch (error) {
        this.failed += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.pending -= 1;
      }
    };
    return run();
  }

  public async waitForIdle(): Promise<void> {
    while (this.pending > 0) {
      await this.sleep(1);
    }
  }

  public status(): RateAwareSchedulerStatus {
    const windowCount = this.windowCount();
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
      window_count: windowCount,
    };
  }

  private async acquire(minHeadroom: number): Promise<void> {
    while (true) {
      const atMs = this.now();
      this.prune(atMs);
      const limit = PROJECTX_HISTORY_BUDGET.requests - minHeadroom;
      if (this.recentStartsMs.length < limit) {
        this.recordStart(atMs);
        return;
      }
      const oldest = this.recentStartsMs[0]!;
      const waitMs = oldest + PROJECTX_HISTORY_BUDGET.windowMs - atMs + 1;
      await this.sleep(Math.max(1, waitMs));
    }
  }

  private prune(atMs: number): void {
    const windowStart = atMs - PROJECTX_HISTORY_BUDGET.windowMs;
    while (this.recentStartsMs.length > 0 && this.recentStartsMs[0]! <= windowStart) {
      this.recentStartsMs.shift();
    }
  }

  private recordStart(startedMs: number): void {
    this.prune(startedMs);
    this.recentStartsMs.push(startedMs);
    this.lastStartedUtc = new Date(startedMs).toISOString();
    this.observedPeakPerWindow = Math.max(this.observedPeakPerWindow, this.recentStartsMs.length);
  }
}
