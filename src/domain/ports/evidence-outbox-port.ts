import type { ProviderEvidenceEvent } from "../provider-evidence.js";

/** TS-REAUDIT-02/07: durable identity evidence staged before memory-queue apply. */
export interface EvidenceOutboxPort {
  stageIdentityOutbox(event: ProviderEvidenceEvent): void;
  outboxPendingCount(): number;
  loadPendingOutboxEvents(): ProviderEvidenceEvent[];
}
