/** Same shape as evidence-queue write latency — no new mechanism. */
export interface SqliteWriteLatencyMetrics {
  last_write_latency_ms: number;
  max_write_latency_ms: number;
  write_count: number;
}

export class SqliteWriteLatencyTracker {
  private lastWriteLatencyMs = 0;
  private maxWriteLatencyMs = 0;
  private writeCount = 0;

  public observe(startedMs: number, endedMs = performance.now()): void {
    const ms = Math.max(0, Math.round(endedMs - startedMs));
    this.lastWriteLatencyMs = ms;
    if (ms > this.maxWriteLatencyMs) {
      this.maxWriteLatencyMs = ms;
    }
    this.writeCount += 1;
  }

  public metrics(): SqliteWriteLatencyMetrics {
    return {
      last_write_latency_ms: this.lastWriteLatencyMs,
      max_write_latency_ms: this.maxWriteLatencyMs,
      write_count: this.writeCount,
    };
  }
}
