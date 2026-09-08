import { randomUUID } from "node:crypto";

export interface UniverseRefreshLogEntry {
  event: "enqueued" | "coalesced" | "started" | "completed" | "failed" | "queue_timeout" | "queue_full";
  job_id: string;
  coalesce_key: string;
  target_contract: string;
  backlog: number;
  duration_ms?: number;
  error?: string;
}

export interface UniverseRefreshQueueOptions {
  maxQueueDepth?: number;
  queueWaitTimeoutMs?: number;
  now?: () => number;
  onLog?: (entry: UniverseRefreshLogEntry) => void;
}

interface Waiter<T> {
  buildResult: () => T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAtMs: number;
}

interface QueuedRefresh {
  jobId: string;
  coalesceKey: string;
  targetContract: string;
  refresh: () => Promise<void>;
  waiters: Waiter<unknown>[];
  enqueuedAtMs: number;
}

/** Serial universe refresh with queued-only coalescing per contract key (TS-DATA-01 PR B). */
export class UniverseRefreshQueue {
  private readonly maxQueueDepth: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly now: () => number;
  private readonly onLog: (entry: UniverseRefreshLogEntry) => void;
  private readonly queue: QueuedRefresh[] = [];
  private running: QueuedRefresh | null = null;
  private runningStartedAtMs = 0;
  private chain: Promise<void> = Promise.resolve();

  public constructor(options: UniverseRefreshQueueOptions = {}) {
    this.maxQueueDepth = Math.max(1, options.maxQueueDepth ?? 32);
    this.queueWaitTimeoutMs = Math.max(1, options.queueWaitTimeoutMs ?? 120_000);
    this.now = options.now ?? Date.now;
    this.onLog = options.onLog ?? (() => undefined);
  }

  public backlog(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  public enqueue<T>(input: {
    coalesceKey: string;
    targetContract: string;
    refresh: () => Promise<void>;
    buildResult: () => T;
  }): Promise<T> {
    this.sweepTimedOutWaiters();
    return new Promise<T>((resolve, reject) => {
      const enqueuedAtMs = this.now();
      const waiter: Waiter<T> = {
        buildResult: input.buildResult,
        resolve,
        reject,
        enqueuedAtMs,
      };
      const existing = this.queue.find((job) => job.coalesceKey === input.coalesceKey);
      if (existing) {
        existing.waiters.push(waiter as Waiter<unknown>);
        this.onLog({
          event: "coalesced",
          job_id: existing.jobId,
          coalesce_key: input.coalesceKey,
          target_contract: input.targetContract,
          backlog: this.backlog(),
        });
        return;
      }
      if (this.queue.length >= this.maxQueueDepth) {
        this.onLog({
          event: "queue_full",
          job_id: randomUUID(),
          coalesce_key: input.coalesceKey,
          target_contract: input.targetContract,
          backlog: this.backlog(),
        });
        reject(new Error("universe_refresh_queue_full"));
        return;
      }
      const jobId = randomUUID();
      this.queue.push({
        jobId,
        coalesceKey: input.coalesceKey,
        targetContract: input.targetContract,
        refresh: input.refresh,
        waiters: [waiter as Waiter<unknown>],
        enqueuedAtMs,
      });
      this.onLog({
        event: "enqueued",
        job_id: jobId,
        coalesce_key: input.coalesceKey,
        target_contract: input.targetContract,
        backlog: this.backlog(),
      });
      this.schedulePump();
    });
  }

  public waitForIdle(): Promise<void> {
    return this.chain;
  }

  private schedulePump(): void {
    this.chain = this.chain.then(() => this.runNext(), () => this.runNext());
  }

  private rejectTimedOutWaiters(job: QueuedRefresh): void {
    const nowMs = this.now();
    job.waiters = job.waiters.filter((waiter) => {
      if (nowMs - waiter.enqueuedAtMs <= this.queueWaitTimeoutMs) {
        return true;
      }
      waiter.reject(new Error("universe_refresh_queue_timeout"));
      this.onLog({
        event: "queue_timeout",
        job_id: job.jobId,
        coalesce_key: job.coalesceKey,
        target_contract: job.targetContract,
        backlog: this.backlog(),
      });
      return false;
    });
  }

  private sweepTimedOutWaiters(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]!;
      this.rejectTimedOutWaiters(job);
      if (job.waiters.length === 0) {
        this.queue.splice(index, 1);
      }
    }
  }

  private async runNext(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }
    const job = this.queue.shift()!;
    this.rejectTimedOutWaiters(job);
    if (job.waiters.length === 0) {
      if (this.queue.length > 0) {
        this.schedulePump();
      }
      return;
    }
    this.running = job;
    this.runningStartedAtMs = this.now();
    this.onLog({
      event: "started",
      job_id: job.jobId,
      coalesce_key: job.coalesceKey,
      target_contract: job.targetContract,
      backlog: this.queue.length,
    });
    try {
      await job.refresh();
      const durationMs = this.now() - this.runningStartedAtMs;
      for (const waiter of job.waiters) {
        waiter.resolve(waiter.buildResult());
      }
      this.onLog({
        event: "completed",
        job_id: job.jobId,
        coalesce_key: job.coalesceKey,
        target_contract: job.targetContract,
        backlog: this.queue.length,
        duration_ms: durationMs,
      });
    } catch (error) {
      for (const waiter of job.waiters) {
        waiter.reject(error);
      }
      this.onLog({
        event: "failed",
        job_id: job.jobId,
        coalesce_key: job.coalesceKey,
        target_contract: job.targetContract,
        backlog: this.queue.length,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = null;
      if (this.queue.length > 0) {
        this.schedulePump();
      }
    }
  }
}
