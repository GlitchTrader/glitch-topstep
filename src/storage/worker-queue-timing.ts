/**
 * Per-message worker timing, split so a later soak can tell queue wait from SQLite.
 * Interval max/count reset on authenticated /health, same window as event_loop_delay.
 * `ownership.current` counts as reconcile: protectedReductionHealth uses it, and it shares
 * this FIFO with appendBatch. HTTP /ownership reads land in the same bucket.
 */

export type WorkerLane = "reconcile" | "evidence" | "other";

const RECONCILE_METHODS = new Set([
  "recoveryStatus",
  "refreshHealthCache",
  "refreshExecutionFactsHealthCache",
  "activeProtectedReduction",
]);

export function workerLane(store: string, method: string): WorkerLane {
  if (store === "evidence" && method === "appendBatch") {
    return "evidence";
  }
  if (store === "ownership" && method === "current") {
    return "reconcile";
  }
  if (RECONCILE_METHODS.has(method)) {
    return "reconcile";
  }
  return "other";
}

export interface WorkerLaneTiming {
  last_queue_wait_ms: number;
  max_queue_wait_ms: number;
  last_exec_ms: number;
  max_exec_ms: number;
  count: number;
}

export interface WorkerQueueTiming {
  reconcile: WorkerLaneTiming;
  evidence: WorkerLaneTiming;
  other: WorkerLaneTiming;
}

function emptyLane(): WorkerLaneTiming {
  return {
    last_queue_wait_ms: 0,
    max_queue_wait_ms: 0,
    last_exec_ms: 0,
    max_exec_ms: 0,
    count: 0,
  };
}

export class WorkerQueueTimingTracker {
  private readonly lanes: Record<WorkerLane, WorkerLaneTiming> = {
    reconcile: emptyLane(),
    evidence: emptyLane(),
    other: emptyLane(),
  };

  public observe(lane: WorkerLane, queueWaitMs: number, execMs: number): void {
    const slot = this.lanes[lane];
    const wait = Math.max(0, Math.round(queueWaitMs));
    const exec = Math.max(0, Math.round(execMs));
    slot.last_queue_wait_ms = wait;
    slot.last_exec_ms = exec;
    if (wait > slot.max_queue_wait_ms) {
      slot.max_queue_wait_ms = wait;
    }
    if (exec > slot.max_exec_ms) {
      slot.max_exec_ms = exec;
    }
    slot.count += 1;
  }

  /** Authenticated /health passes reset so the next watchdog sample is one poll window. */
  public snapshot(options: { reset?: boolean } = {}): WorkerQueueTiming {
    const copy: WorkerQueueTiming = {
      reconcile: { ...this.lanes.reconcile },
      evidence: { ...this.lanes.evidence },
      other: { ...this.lanes.other },
    };
    if (options.reset) {
      for (const lane of Object.values(this.lanes)) {
        lane.max_queue_wait_ms = 0;
        lane.max_exec_ms = 0;
        lane.count = 0;
      }
    }
    return copy;
  }
}
