import {
  buildFlattenVenueSnapshot,
  resolveFlattenAfterReceipt,
  resolveFlattenAfterRestart,
  shouldCompletePendingFlatten,
} from "../service/flatten-workflow.js";
import type { AuthenticatedProjectXPort } from "../domain/ports/authenticated-project-x-port.js";
import type { EvidenceOutboxPort } from "../domain/ports/evidence-outbox-port.js";
import type { FlattenSagaPort } from "../domain/ports/flatten-saga-port.js";
import type { IntentDeliveryStatusPort } from "../domain/ports/intent-delivery-status-port.js";
import type { OutcomeProjectionPort } from "../domain/ports/outcome-projection-port.js";
import type { TradeOutcomePublisher } from "../learning/trade-outcome-publisher.js";
import type { ProjectXAuthManager } from "../projectx/auth-manager.js";
import type { SqliteExecutionStore } from "../storage/sqlite-execution-store.js";
import type { SqliteProviderEvidenceStore } from "../storage/sqlite-provider-evidence-store.js";
import type { TradeOutcomeStore } from "../storage/trade-outcome-store.js";

/** ponytail: structural adapters only — AppService still owns construction until wave 4. */
export const flattenSagaPort: FlattenSagaPort = {
  buildVenueSnapshot: buildFlattenVenueSnapshot,
  resolveAfterReceipt: resolveFlattenAfterReceipt,
  resolveAfterRestart: resolveFlattenAfterRestart,
  shouldCompletePending: shouldCompletePendingFlatten,
};

export function asAuthenticatedProjectXPort(
  authManager: ProjectXAuthManager,
): AuthenticatedProjectXPort {
  return authManager;
}

export function asEvidenceOutboxPort(
  store: SqliteProviderEvidenceStore,
): EvidenceOutboxPort {
  return store;
}

export function asIntentDeliveryStatusPort(
  store: SqliteExecutionStore,
): IntentDeliveryStatusPort {
  return store;
}

export function asOutcomeProjectionPort(
  publisher: TradeOutcomePublisher,
  store: TradeOutcomeStore,
): OutcomeProjectionPort {
  return {
    publishClosedTranches: (input) => publisher.publishClosedTranches(input),
    revisionPage: (afterSequence, limit) => store.revisionPage(afterSequence, limit),
    current: () => store.all(),
  };
}

export interface ProductionPortBindings {
  authenticatedProjectX: AuthenticatedProjectXPort;
  flattenSaga: FlattenSagaPort;
  evidenceOutbox: EvidenceOutboxPort;
  intentDeliveryStatus: IntentDeliveryStatusPort;
  outcomeProjection: OutcomeProjectionPort;
}
