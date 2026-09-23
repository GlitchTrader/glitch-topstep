import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderEvidenceEvent } from "../src/domain/provider-evidence.js";
import { EvidenceWriteQueue } from "../src/projectx/evidence-write-queue.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";

function identityOrder(id: string, receivedUtc: string): ProviderEvidenceEvent {
  return {
    receivedUtc,
    providerTimestampUtc: null,
    source: "projectx_user_stream",
    eventType: "order",
    generation: 3,
    accountId: 26_282_486,
    contractId: "CON.F.US.MNQ.U26",
    providerEntityId: id,
    rawPayload: { id },
    normalizedPayload: { id, status: 1 },
  };
}

describe("identity outbox vs provider_events under crash", () => {
  it("reopens pending outbox and applies each identity row once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-outbox-crash-"));
    const path = join(directory, "evidence.sqlite");
    const first = identityOrder("crash-1", "2026-09-23T18:00:00.000Z");
    const second = identityOrder("crash-2", "2026-09-23T18:00:01.000Z");
    try {
      let store = new SqliteProviderEvidenceStore(path);
      store.stageIdentityOutbox(first);
      store.stageIdentityOutbox(second);
      store.appendBatch([first]);
      store.close();

      store = new SqliteProviderEvidenceStore(path);
      const pending = store.loadPendingOutboxEvents();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.providerEntityId, "crash-2");
      assert.equal(store.query({ providerEntityId: "crash-1" }).length, 1);
      assert.equal(store.query({ providerEntityId: "crash-2" }).length, 0);

      const queue = new EvidenceWriteQueue(store);
      while (true) {
        const batch = store.loadPendingOutboxEvents(500);
        if (batch.length === 0) {
          break;
        }
        for (const item of batch) {
          queue.submit(item, null, { skipOutboxStage: true });
        }
        await queue.drain();
      }
      assert.equal(store.outboxPendingCount(), 0);
      const recovered = store.query({ providerEntityId: "crash-2" });
      assert.equal(recovered.length, 1);
      assert.equal(store.query({ providerEntityId: "crash-1" }).length, 1);
      assert.match(recovered[0]?.payloadHash ?? "", /^[0-9a-f]{64}$/);
      store.close();

      store = new SqliteProviderEvidenceStore(path);
      assert.equal(store.outboxPendingCount(), 0);
      assert.equal(store.query({ source: "projectx_user_stream" }).length, 2);
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
