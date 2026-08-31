/**
 * Coordinates dispatch of periodic REST-bound work that previously ran as four fully
 * independent `setInterval` callbacks in AppService (reconcile, market observation, order
 * flow, history sync) with no shared concurrency limit or ordering -- meaning a post-reconnect
 * burst could fire all four at once, competing for the same REST budget with no defined
 * outcome (TS-STREAM-RECOVERY-01 PR-F; diagnosed in
 * docs/plans/2026-08-27-stream-recovery-implementation-plan.md as one of the causes of the
 * 2026-08-27/31 flapping).
 *
 * Callers still decide WHEN to request a task -- each caller's own `setInterval` cadence is
 * unchanged, so the frequency of every task is identical to before this existed. This class
 * decides in what ORDER queued requests run and how many run AT ONCE, which is the actual gap
 * that had no defined behavior previously.
 *
 * This does not touch, weaken, or bypass `quote_stale` / `state_complete` entry gates -- it is
 * strictly a REST-dispatch concurrency/ordering layer underneath work that was already running.
 */

export type TaskPriority =
  | "critical_reconcile"
  | "market_recovery"
  | "market_observation"
  | "order_flow"
  | "history_sync";

const PRIORITY_ORDER: readonly TaskPriority[] = [
  "critical_reconcile",
  "market_recovery",
  "market_observation",
  "order_flow",
  "history_sync",
];

export interface TaskSchedulerCounters {
  queued: number;
  running: number;
  deferred: number;
  failed: number;
  completed: number;
}

interface QueuedTask {
  id: string;
  priority: TaskPriority;
  run: () => Promise<unknown>;
  enqueuedAtMs: number;
  deadlineMs: number;
}

export interface TaskSchedulerOptions {
  /** Global cap on REST-bound tasks running at once, across every priority. */
  maxConcurrent?: number;
  now?: () => number;
  onError?: (task: { id: string; priority: TaskPriority }, error: unknown) => void;
}

export class TaskScheduler {
  private readonly queue: QueuedTask[] = [];
  private runningCount = 0;
  private completed = 0;
  private failed = 0;
  private deferred = 0;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly onError: (task: { id: string; priority: TaskPriority }, error: unknown) => void;

  public constructor(options: TaskSchedulerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.now = options.now ?? Date.now;
    this.onError = options.onError
      ?? ((task, error) => console.error(`scheduled task failed: ${task.id}`, error));
  }

  public counts(): TaskSchedulerCounters {
    return {
      queued: this.queue.length,
      running: this.runningCount,
      deferred: this.deferred,
      failed: this.failed,
      completed: this.completed,
    };
  }

  /**
   * Enqueues work identified by `id`. A task with an id already queued (not yet dispatched) is
   * coalesced -- the caller's next periodic tick does not pile up a duplicate run behind one
   * that hasn't started yet.
   */
  public enqueue(
    priority: TaskPriority,
    id: string,
    run: () => Promise<unknown>,
    deadlineMs = 30_000,
  ): void {
    if (this.queue.some((task) => task.id === id)) {
      return;
    }
    this.queue.push({ id, priority, run, enqueuedAtMs: this.now(), deadlineMs });
    this.pump();
  }

  public async waitForIdle(): Promise<void> {
    while (this.runningCount > 0 || this.queue.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }

  private pump(): void {
    while (this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const next = this.selectNext();
      if (!next) {
        return;
      }
      this.dispatch(next);
    }
  }

  /**
   * Priority order picks the next task, EXCEPT a task that has been waiting past its own
   * deadline always wins -- this is the starvation guard: a continuous stream of
   * `critical_reconcile` requests cannot indefinitely starve `history_sync`.
   */
  private selectNext(): QueuedTask | null {
    if (this.queue.length === 0) {
      return null;
    }
    const nowMs = this.now();
    const overdueIndex = this.queue.findIndex(
      (task) => nowMs - task.enqueuedAtMs >= task.deadlineMs,
    );
    if (overdueIndex >= 0) {
      this.deferred += 1;
      return this.queue.splice(overdueIndex, 1)[0] ?? null;
    }
    let bestIndex = 0;
    let bestRank = PRIORITY_ORDER.indexOf(this.queue[0]!.priority);
    for (let i = 1; i < this.queue.length; i += 1) {
      const rank = PRIORITY_ORDER.indexOf(this.queue[i]!.priority);
      if (rank < bestRank) {
        bestRank = rank;
        bestIndex = i;
      }
    }
    return this.queue.splice(bestIndex, 1)[0] ?? null;
  }

  private dispatch(task: QueuedTask): void {
    this.runningCount += 1;
    task.run()
      .then(() => {
        this.completed += 1;
      })
      .catch((error: unknown) => {
        this.failed += 1;
        this.onError({ id: task.id, priority: task.priority }, error);
      })
      .finally(() => {
        this.runningCount -= 1;
        this.pump();
      });
  }
}
