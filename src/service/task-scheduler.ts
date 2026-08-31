/**
 * Coordinates dispatch of periodic and event-triggered REST-bound work that previously ran as
 * independent, uncoordinated calls in AppService (reconcile, market observation, order flow,
 * history sync -- both from four separate `setInterval` callbacks AND from the post-reconnect
 * recovery pipeline `handleHubReconnected`) with no shared concurrency limit or ordering --
 * meaning a post-reconnect burst could fire all of it at once, competing for the same REST
 * budget with no defined outcome (TS-STREAM-RECOVERY-01 PR-F; diagnosed in
 * docs/plans/2026-08-27-stream-recovery-implementation-plan.md as one of the causes of the
 * 2026-08-27/31 flapping).
 *
 * Callers still decide WHEN to request a task -- each caller's own trigger (a `setInterval` tick,
 * or a reconnect event) is unchanged, so the frequency/occasion of every task is identical to
 * before this existed. This class decides in what ORDER queued requests run and how many run AT
 * ONCE, which is the actual gap that had no defined behavior previously. `enqueue()` returns the
 * task's own result as a promise specifically so a caller with sequencing requirements (the
 * recovery pipeline must reconcile, then observe, then sync history, in that order, aborting
 * early on a stale generation) can `await` each scheduled step instead of firing and forgetting.
 *
 * Coalescing works across BOTH callers: if the periodic reconcile timer and the recovery
 * pipeline both want a "reconcile" run at the same moment, only one actually executes and both
 * callers await its single result -- using the same task ids in both places is what makes this
 * work, see AppService's timers and `handleHubReconnected`.
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
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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
   * Enqueues work identified by `id` and returns a promise for its result. A task with an id
   * already queued (not yet dispatched) is coalesced -- the new caller is handed the SAME
   * promise as the original request, and only one execution actually happens. A caller that
   * doesn't need the result (the periodic timers) can simply not await the returned promise.
   */
  public enqueue<T = void>(
    priority: TaskPriority,
    id: string,
    run: () => Promise<T>,
    deadlineMs = 30_000,
  ): Promise<T> {
    const existing = this.queue.find((task) => task.id === id);
    if (existing) {
      // A coalesced task runs at the best (lowest-index) priority any waiting caller requested,
      // not just whichever caller happened to enqueue it first.
      if (PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(existing.priority)) {
        existing.priority = priority;
      }
      return new Promise<T>((resolve, reject) => {
        const priorResolve = existing.resolve;
        const priorReject = existing.reject;
        existing.resolve = (value) => {
          priorResolve(value);
          resolve(value as T);
        };
        existing.reject = (error) => {
          priorReject(error);
          reject(error);
        };
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        priority,
        run: run as () => Promise<unknown>,
        enqueuedAtMs: this.now(),
        deadlineMs,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
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
      .then((value) => {
        this.completed += 1;
        task.resolve(value);
      })
      .catch((error: unknown) => {
        this.failed += 1;
        this.onError({ id: task.id, priority: task.priority }, error);
        task.reject(error);
      })
      .finally(() => {
        this.runningCount -= 1;
        this.pump();
      });
  }
}
