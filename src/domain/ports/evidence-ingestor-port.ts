import type { ProviderEvidenceEvent } from "../provider-evidence.js";

export type EvidenceQueueClass = "identity" | "quote" | "depth" | "print";
export type EvidenceSubmitOutcome = "queued" | "coalesced" | "dropped";

export interface EvidenceIngestorMetrics {
  depth: number;
  identity_depth: number;
  degraded: boolean;
  enqueued: number;
  persisted: number;
  dropped: Record<EvidenceQueueClass, number>;
  resume_cursor: number | null;
}

/** Bounded ingest in front of durable provider evidence (TS-PROD-05). */
export interface EvidenceIngestorPort {
  submit(
    event: ProviderEvidenceEvent,
    eventClass: EvidenceQueueClass,
    onDurable?: () => void,
  ): EvidenceSubmitOutcome;
  metrics(): EvidenceIngestorMetrics;
  close(): Promise<void>;
}
