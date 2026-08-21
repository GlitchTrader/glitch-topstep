import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  asAuthenticatedProjectXPort,
  asEvidenceOutboxPort,
  asIntentDeliveryStatusPort,
  asOutcomeProjectionPort,
  flattenSagaPort,
} from "../src/composition/production-ports.js";
import type { AuthenticatedProjectXPort } from "../src/domain/ports/authenticated-project-x-port.js";
import type { EvidenceOutboxPort } from "../src/domain/ports/evidence-outbox-port.js";
import type { FlattenSagaPort } from "../src/domain/ports/flatten-saga-port.js";
import type { IntentDeliveryStatusPort } from "../src/domain/ports/intent-delivery-status-port.js";
import type { OutcomeProjectionPort } from "../src/domain/ports/outcome-projection-port.js";
import { TradeOutcomePublisher } from "../src/learning/trade-outcome-publisher.js";
import { ProjectXAuthManager } from "../src/projectx/auth-manager.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";
import { TradeOutcomeStore } from "../src/storage/trade-outcome-store.js";

function assertPort<T>(binding: T): T {
  return binding;
}

test("TS-REAUDIT-07 production bindings satisfy runtime ports", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "glitch-composition-"));
  const auth = assertPort<AuthenticatedProjectXPort>(
    asAuthenticatedProjectXPort(
      new ProjectXAuthManager({
        apiUrl: "https://example.invalid",
        username: "operator",
        apiKey: "test-key",
      }),
    ),
  );
  assert.equal(typeof auth.apiClient, "function");
  assert.equal(typeof auth.ensureAuthenticated, "function");

  const flatten = assertPort<FlattenSagaPort>(flattenSagaPort);
  assert.equal(typeof flatten.buildVenueSnapshot, "function");
  assert.equal(typeof flatten.shouldCompletePending, "function");

  const evidenceStore = new SqliteProviderEvidenceStore(
    join(dataDir, "projectx-evidence.sqlite"),
  );
  const evidenceOutbox = assertPort<EvidenceOutboxPort>(asEvidenceOutboxPort(evidenceStore));
  assert.equal(evidenceOutbox.outboxPendingCount(), 0);

  const executionStore = new SqliteExecutionStore(join(dataDir, "glitch-topstep.sqlite"));
  const intentDelivery = assertPort<IntentDeliveryStatusPort>(
    asIntentDeliveryStatusPort(executionStore),
  );
  assert.equal(intentDelivery.intentDeliveryStatus("missing-intent").status, "not_seen");

  const outcomeStore = new TradeOutcomeStore(dataDir, "trade-outcomes.jsonl");
  await outcomeStore.load();
  const outcomeProjection = assertPort<OutcomeProjectionPort>(
    asOutcomeProjectionPort(
      new TradeOutcomePublisher(
        {
          searchTrades: async () => [],
        },
        outcomeStore,
        { settleMs: 0, retrySettleMs: 0, sleep: async () => {} },
      ),
      outcomeStore,
    ),
  );
  assert.deepEqual(outcomeProjection.current(), []);
  assert.equal(outcomeProjection.revisionPage(0, 10).count, 0);

  evidenceStore.close();
  executionStore.close();
  await outcomeStore.close();
});
