/**
 * Single trailing-debounce gate for hub recovery REST (TS-STREAM-RECOVERY-01 item 2).
 * User and market onReconnected share one in-flight pass; overlapping calls request
 * at most one extra pass after it, not one pipeline per event.
 *
 * ponytail: AppService owns the instance. Ceiling is "one extra pass", not a
 * shared pipeline with TaskScheduler's in-flight reconcile (queued-only coalesce).
 */
export class RecoveryPipelineGate {
  private running: Promise<void> | null = null;
  private rerunRequested = false;

  public run(execute: () => Promise<void>): Promise<void> {
    this.rerunRequested = true;
    if (this.running) {
      return this.running;
    }
    this.running = this.loop(execute);
    return this.running;
  }

  private async loop(execute: () => Promise<void>): Promise<void> {
    try {
      while (this.rerunRequested) {
        this.rerunRequested = false;
        await execute();
      }
    } finally {
      this.running = null;
      if (this.rerunRequested) {
        await this.run(execute);
      }
    }
  }
}
