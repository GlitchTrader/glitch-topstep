import type { ProviderEvidenceEvent } from "../domain/provider-evidence.js";

/**
 * Bounded, priority-classed queue in front of the durable evidence store.
 *
 * Persist-before-apply is preserved: the caller hands over an `onDurable` callback that only
 * runs after the batch containing its event committed. Nothing an operator can observe in
 * `VenueStateStore` is state that was not written first.
 *
 * Classes and their deterministic policy:
 * - `identity` (user stream, REST, lifecycle): never coalesced, never dropped, no bound.
 * - `quote`: coalesced per contract once depth >= `coalesceWatermark`; newest wins and keeps
 *   its own arrival position, so persisted order stays monotone in `receivedUtc`.
 * - `depth`: coalesced per contract/side/price under the same watermark (last level update wins).
 * - `print` (market trades): never coalesced (each print is unique); dropped only above the
 *   high-water mark, always counted.
 *
 * Overflow is fail-visible, never silent: the first crossing of the high-water mark raises
 * `onDegraded` once and only re-arms after the queue falls back to `lowWaterMark`.
 */
export type EvidenceQueueClass = "identity" | "quote" | "depth" | "print";

export interface DurableEvidenceWriter {
  appendBatch(events: readonly ProviderEvidenceEvent[]): readonly { sequence: number }[];
}

export type EvidenceSubmitOutcome = "queued" | "coalesced" | "dropped";

export interface EvidenceQueueMetrics {
  depth: number;
  physical_depth: number;
  identity_depth: number;
  oldest_age_ms: number;
  degraded: boolean;
  high_water_mark: number;
  coalesce_watermark: number;
  high_water_hits: number;
  enqueued: number;
  persisted: number;
  coalesced: Record<EvidenceQueueClass, number>;
  dropped: Record<EvidenceQueueClass, number>;
  last_batch_size: number;
  last_write_latency_ms: number;
  max_write_latency_ms: number;
  write_failures: number;
  consecutive_write_failures: number;
  apply_failures: number;
  resume_cursor: number | null;
  closed: boolean;
  /** True when shutdown drain failed with recoverable backlog (TS-AUDIT-08). */
  incomplete_shutdown: boolean;
}

export interface EvidenceWriteQueueOptions {
  highWaterMark?: number;
  coalesceWatermark?: number;
  lowWaterMark?: number;
  batchSize?: number;
  batchIntervalMs?: number;
  onDegraded?: (metrics: EvidenceQueueMetrics) => void;
  onRecovered?: (metrics: EvidenceQueueMetrics) => void;
  onWriteError?: (error: unknown, pending: number) => void;
  onApplyError?: (error: unknown, event: ProviderEvidenceEvent) => void;
  /** TS-REAUDIT-02: sqlite outbox insert before identity enqueue. */
  onStageIdentity?: (event: ProviderEvidenceEvent) => void;
  now?: () => number;
}

interface QueueEntry {
  event: ProviderEvidenceEvent;
  eventClass: EvidenceQueueClass;
  coalesceKey: string | null;
  enqueuedAtMs: number;
  onDurable: (() => void) | null;
  superseded: boolean;
}

// Sized against the TS-R2-07 observation (~124 market events/s): the high-water mark is ~40s of
// backlog, so crossing it means the writer is genuinely stuck rather than momentarily behind.
const DEFAULT_HIGH_WATER_MARK = 5_000;
const DEFAULT_COALESCE_WATERMARK = 1_000;
const DEFAULT_LOW_WATER_MARK = 250;
const DEFAULT_BATCH_SIZE = 256;
const DEFAULT_BATCH_INTERVAL_MS = 5;
const DRAIN_WRITE_FAILURE_LIMIT = 3;
const COMPACT_THRESHOLD = 1_024;
/** ponytail: hard cap on backing array; superseded slots reclaimed aggressively (audit 2026-08-25 C2). */
const MAX_PHYSICAL_ENTRIES = 8_192;

export class EvidenceWriteQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly pendingByKey = new Map<string, QueueEntry>();
  private head = 0;
  private pending = 0;
  private identityPending = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private degraded = false;
  private closed = false;
  private highWaterHits = 0;
  private enqueued = 0;
  private persisted = 0;
  private lastBatchSize = 0;
  private lastWriteLatencyMs = 0;
  private maxWriteLatencyMs = 0;
  private writeFailures = 0;
  private consecutiveWriteFailures = 0;
  private applyFailures = 0;
  private resumeCursor: number | null = null;
  private incompleteShutdown = false;
  private readonly coalesced: Record<EvidenceQueueClass, number> = emptyCounters();
  private readonly dropped: Record<EvidenceQueueClass, number> = emptyCounters();

  private readonly highWaterMark: number;
  private readonly coalesceWatermark: number;
  private readonly lowWaterMark: number;
  private readonly batchSize: number;
  private readonly batchIntervalMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly writer: DurableEvidenceWriter,
    private readonly options: EvidenceWriteQueueOptions = {},
  ) {
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.coalesceWatermark = options.coalesceWatermark ?? DEFAULT_COALESCE_WATERMARK;
    this.lowWaterMark = options.lowWaterMark ?? DEFAULT_LOW_WATER_MARK;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    if (this.coalesceWatermark > this.highWaterMark || this.lowWaterMark > this.coalesceWatermark) {
      throw new Error("evidence_queue_watermarks_invalid");
    }
    if (this.batchSize < 1) {
      throw new Error("evidence_queue_batch_size_invalid");
    }
  }

  /** `ProviderEvidenceSink` compatibility: enqueue without a durable acknowledgement. */
  public append(event: ProviderEvidenceEvent): void {
    this.submit(event, null);
  }

  /** Enqueue and run `onDurable` only after the event is committed. */
  public submit(
    event: ProviderEvidenceEvent,
    onDurable: (() => void) | null,
    options?: { skipOutboxStage?: boolean },
  ): EvidenceSubmitOutcome {
    if (this.closed) {
      throw new Error("evidence_queue_closed");
    }
    const eventClass = classify(event);
    if (eventClass === "identity" && !options?.skipOutboxStage) {
      this.options.onStageIdentity?.(event);
    }
    if (eventClass === "identity" && this.identityPending >= this.highWaterMark) {
      this.raiseDegraded();
      // ponytail: identity spills via sqlite outbox when in-memory window is full (TS-REAUDIT-02).
      return "queued";
    }
    const coalesceKey = coalesceKeyFor(event, eventClass);

    if (eventClass !== "identity" && this.pending >= this.coalesceWatermark && coalesceKey !== null) {
      const superseded = this.pendingByKey.get(coalesceKey);
      if (superseded) {
        superseded.superseded = true;
        this.pending -= 1;
        this.coalesced[eventClass] += 1;
        this.pendingByKey.delete(coalesceKey);
      }
    }

    if (eventClass !== "identity" && this.pending >= this.highWaterMark) {
      this.dropped[eventClass] += 1;
      this.raiseDegraded();
      return "dropped";
    }

    const entry: QueueEntry = {
      event,
      eventClass,
      coalesceKey,
      enqueuedAtMs: this.now(),
      onDurable,
      superseded: false,
    };
    this.entries.push(entry);
    this.pending += 1;
    this.enqueued += 1;
    if (eventClass === "identity") {
      this.identityPending += 1;
    }
    if (coalesceKey !== null) {
      this.pendingByKey.set(coalesceKey, entry);
    }
    if (this.pending >= this.highWaterMark) {
      this.raiseDegraded();
    }
    this.schedule();
    return "queued";
  }

  public metrics(): EvidenceQueueMetrics {
    return {
      depth: this.pending,
      physical_depth: this.entries.length - this.head,
      identity_depth: this.identityPending,
      oldest_age_ms: this.oldestAgeMs(),
      degraded: this.degraded,
      high_water_mark: this.highWaterMark,
      coalesce_watermark: this.coalesceWatermark,
      high_water_hits: this.highWaterHits,
      enqueued: this.enqueued,
      persisted: this.persisted,
      coalesced: { ...this.coalesced },
      dropped: { ...this.dropped },
      last_batch_size: this.lastBatchSize,
      last_write_latency_ms: this.lastWriteLatencyMs,
      max_write_latency_ms: this.maxWriteLatencyMs,
      write_failures: this.writeFailures,
      consecutive_write_failures: this.consecutiveWriteFailures,
      apply_failures: this.applyFailures,
      resume_cursor: this.resumeCursor,
      closed: this.closed,
      incomplete_shutdown: this.incompleteShutdown,
    };
  }

  /** Write everything currently queued, yielding to the event loop between batches. */
  public async drain(): Promise<void> {
    while (this.pending > 0) {
      this.runBatch();
      if (this.consecutiveWriteFailures >= DRAIN_WRITE_FAILURE_LIMIT) {
        throw new Error(
          `evidence_queue_drain_failed:pending=${this.pending}:resume_cursor=${this.resumeCursor ?? "none"}`,
        );
      }
      await yieldToEventLoop();
    }
  }

  /** Drain, then refuse further writes. Callers must stop the streams first. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.drain();
    } catch (error) {
      this.incompleteShutdown = true;
      throw error;
    }
    this.closed = true;
    this.clearTimer();
  }

  private schedule(): void {
    if (this.timer !== null || this.closed || this.pending === 0) {
      return;
    }
    const delay = this.pending >= this.batchSize ? 0 : this.batchIntervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runBatch();
      this.schedule();
    }, delay);
    this.timer.unref?.();
  }

  private runBatch(): void {
    const startHead = this.head;
    const batch = this.takeBatch();
    if (batch.length === 0) {
      return;
    }
    const startedMs = this.now();
    let stored: readonly { sequence: number }[];
    try {
      stored = this.writer.appendBatch(batch.map((entry) => entry.event));
    } catch (error) {
      this.restore(batch, startHead);
      this.compactSuperseded();
      this.writeFailures += 1;
      this.consecutiveWriteFailures += 1;
      this.raiseDegraded();
      this.options.onWriteError?.(error, this.pending);
      return;
    }
    const latency = this.now() - startedMs;
    this.compact();
    this.consecutiveWriteFailures = 0;
    this.persisted += batch.length;
    this.lastBatchSize = batch.length;
    this.lastWriteLatencyMs = latency;
    this.maxWriteLatencyMs = Math.max(this.maxWriteLatencyMs, latency);
    const lastSequence = stored.at(-1)?.sequence;
    if (typeof lastSequence === "number") {
      this.resumeCursor = lastSequence;
    }
    for (const entry of batch) {
      if (!entry.onDurable) {
        continue;
      }
      try {
        entry.onDurable();
      } catch (error) {
        this.applyFailures += 1;
        this.options.onApplyError?.(error, entry.event);
      }
    }
    this.maybeRecover();
  }

  private takeBatch(): QueueEntry[] {
    const batch: QueueEntry[] = [];
    while (this.head < this.entries.length && batch.length < this.batchSize) {
      const entry = this.entries[this.head];
      this.head += 1;
      if (!entry || entry.superseded) {
        continue;
      }
      // An entry handed to the writer is no longer a coalescing target: a later duplicate must
      // queue behind it rather than replace something already being persisted.
      if (entry.coalesceKey !== null && this.pendingByKey.get(entry.coalesceKey) === entry) {
        this.pendingByKey.delete(entry.coalesceKey);
      }
      this.pending -= 1;
      if (entry.eventClass === "identity") {
        this.identityPending -= 1;
      }
      batch.push(entry);
    }
    return batch;
  }

  private restore(batch: readonly QueueEntry[], startHead: number): void {
    this.head = startHead;
    for (const entry of batch) {
      this.pending += 1;
      if (entry.eventClass === "identity") {
        this.identityPending += 1;
      }
    }
  }

  private compact(): void {
    this.compactSuperseded();
    if (this.head < COMPACT_THRESHOLD) {
      return;
    }
    this.entries.splice(0, this.head);
    this.head = 0;
  }

  private compactSuperseded(): void {
    while (this.head < this.entries.length && this.entries[this.head]?.superseded) {
      this.head += 1;
    }
    if (this.head >= COMPACT_THRESHOLD) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
    while (this.entries.length - this.head > MAX_PHYSICAL_ENTRIES) {
      const dropIndex = this.head;
      if (dropIndex >= this.entries.length) {
        break;
      }
      const entry = this.entries[dropIndex];
      if (!entry || !entry.superseded) {
        break;
      }
      this.head += 1;
    }
    if (this.head >= COMPACT_THRESHOLD) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }

  private oldestAgeMs(): number {
    for (let index = this.head; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry && !entry.superseded) {
        return Math.max(0, this.now() - entry.enqueuedAtMs);
      }
    }
    return 0;
  }

  private raiseDegraded(): void {
    if (this.degraded) {
      return;
    }
    this.degraded = true;
    this.highWaterHits += 1;
    this.options.onDegraded?.(this.metrics());
  }

  private maybeRecover(): void {
    if (!this.degraded || this.pending > this.lowWaterMark || this.consecutiveWriteFailures > 0) {
      return;
    }
    this.degraded = false;
    this.options.onRecovered?.(this.metrics());
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function classify(event: ProviderEvidenceEvent): EvidenceQueueClass {
  if (event.source !== "projectx_market_stream") {
    return "identity";
  }
  if (event.eventType === "quote") {
    return "quote";
  }
  if (event.eventType === "depth") {
    return "depth";
  }
  return "print";
}

function coalesceKeyFor(event: ProviderEvidenceEvent, eventClass: EvidenceQueueClass): string | null {
  if (eventClass === "quote") {
    return `quote|${event.contractId ?? ""}`;
  }
  if (eventClass === "depth") {
    const payload = event.normalizedPayload as { type?: unknown; price?: unknown } | null;
    return `depth|${event.contractId ?? ""}|${String(payload?.type)}|${String(payload?.price)}`;
  }
  return null;
}

function emptyCounters(): Record<EvidenceQueueClass, number> {
  return { identity: 0, quote: 0, depth: 0, print: 0 };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
