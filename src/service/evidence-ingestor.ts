import type { ProviderEvidenceEvent } from "../domain/provider-evidence.js";
import type {
  EvidenceIngestorMetrics,
  EvidenceIngestorPort,
  EvidenceQueueClass,
  EvidenceSubmitOutcome,
} from "../domain/ports/evidence-ingestor-port.js";
import type { EvidenceWriteQueue } from "../projectx/evidence-write-queue.js";

/** Adapter surface for bounded provider evidence ingest (TS-PROD-05). */
export interface EvidenceIngestor extends EvidenceIngestorPort {}

export class EvidenceIngestorAdapter implements EvidenceIngestor {
  public constructor(private readonly queue: EvidenceWriteQueue) {}

  public submit(
    event: ProviderEvidenceEvent,
    _eventClass: EvidenceQueueClass,
    onDurable?: () => void,
  ): EvidenceSubmitOutcome {
    return this.queue.submit(event, onDurable ?? null);
  }

  public metrics(): EvidenceIngestorMetrics {
    const metrics = this.queue.metrics();
    return {
      depth: metrics.depth,
      identity_depth: metrics.identity_depth,
      degraded: metrics.degraded,
      enqueued: metrics.enqueued,
      persisted: metrics.persisted,
      dropped: metrics.dropped,
      resume_cursor: metrics.resume_cursor,
    };
  }

  public close(): Promise<void> {
    return this.queue.close();
  }
}

export function adaptEvidenceWriteQueue(queue: EvidenceWriteQueue): EvidenceIngestor {
  return new EvidenceIngestorAdapter(queue);
}
