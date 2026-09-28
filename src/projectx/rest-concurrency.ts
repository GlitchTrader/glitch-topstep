import { PRIORITY_ORDER, type TaskPriority } from "../service/task-scheduler.js";

/** ponytail: same rank as TaskScheduler; waiter queue only — in-flight is not preempted. */
export interface RestConcurrencySnapshot {
  in_flight: number;
  waiting: number;
  max_concurrent: number;
}

export class RestGateAcquireTimeoutError extends Error {
  public constructor(message = "rest_gate_acquire_timeout") {
    super(message);
    this.name = "RestGateAcquireTimeoutError";
  }
}

interface RestWaiter {
  priority: TaskPriority;
  start: () => void;
}

export class RestConcurrencyGate {
  private inFlight = 0;
  private readonly waiters: RestWaiter[] = [];

  public constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("rest_concurrency_invalid");
    }
  }

  public snapshot(): RestConcurrencySnapshot {
    return {
      in_flight: this.inFlight,
      waiting: this.waiters.length,
      max_concurrent: this.maxConcurrent,
    };
  }

  public async run<T>(
    work: () => Promise<T>,
    priority: TaskPriority = "history_sync",
    options?: { acquireTimeoutMs?: number },
  ): Promise<T> {
    await this.acquire(priority, options?.acquireTimeoutMs);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(priority: TaskPriority, acquireTimeoutMs?: number): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: RestWaiter = {
        priority,
        start: () => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          this.inFlight += 1;
          resolve();
        },
      };
      this.waiters.push(waiter);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (acquireTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new RestGateAcquireTimeoutError());
        }, Math.max(0, acquireTimeoutMs));
      }
    });
  }

  private release(): void {
    this.inFlight -= 1;
    if (this.waiters.length === 0) {
      return;
    }
    let best = 0;
    for (let i = 1; i < this.waiters.length; i += 1) {
      const candidate = this.waiters[i];
      const current = this.waiters[best];
      if (!candidate || !current) {
        continue;
      }
      if (PRIORITY_ORDER.indexOf(candidate.priority) < PRIORITY_ORDER.indexOf(current.priority)) {
        best = i;
      }
    }
    const next = this.waiters.splice(best, 1)[0];
    next?.start();
  }
}
