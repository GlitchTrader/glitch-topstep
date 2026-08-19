export interface RateAwareSchedulerStatus {
  pending: number;
  completed: number;
  failed: number;
  last_started_utc: string | null;
  last_error: string | null;
}

export class RateAwareScheduler {
  private chain: Promise<void> = Promise.resolve();
  private nextStartMs = 0;
  private pending = 0;
  private completed = 0;
  private failed = 0;
  private lastStartedUtc: string | null = null;
  private lastError: string | null = null;
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
    };
  }
}

