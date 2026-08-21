import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { ProviderEvidenceEvent } from "../src/domain/provider-evidence.js";
import { buildExecutionGates } from "../src/execution/gateway-mode.js";
import { snapshot } from "./fixtures.js";

function healthyRecovery(): ExecutionRecoveryStatus {
  return {
    blockingAmbiguity: false,
    entrySubmissionPending: false,
    blockingNewExposure: false,
    unresolvedMutations: 0,
    ambiguousMutations: 0,
    lastRecoveryUtc: null,
    lastRecoveryError: null,
  };
}

describe("TS-REAUDIT-02 evidence outbox", () => {
  it("stages identity events before queue accepts them", async () => {
    const { SqliteProviderEvidenceStore } = await import("../src/storage/sqlite-provider-evidence-store.js");
    const { EvidenceWriteQueue } = await import("../src/projectx/evidence-write-queue.js");
    const store = new SqliteProviderEvidenceStore(":memory:");
    const event: ProviderEvidenceEvent = {
      receivedUtc: "2026-08-21T12:00:00.000Z",
      providerTimestampUtc: null,
      source: "projectx_user_stream",
      eventType: "order",
      generation: 1,
      accountId: 1,
      contractId: "CON.F.US.MNQ.U26",
      providerEntityId: "42",
      rawPayload: { id: 42 },
      normalizedPayload: { id: 42 },
    };
    const queue = new EvidenceWriteQueue(store, {
      onStageIdentity: (queued) => store.stageIdentityOutbox(queued),
    });
    assert.equal(store.outboxPendingCount(), 0);
    queue.submit(event, null);
    assert.equal(store.outboxPendingCount(), 1);
    await queue.drain();
    assert.equal(store.outboxPendingCount(), 0);
    store.close();
  });

  it("replays pending outbox on restart without duplicating rows", async () => {
    const { SqliteProviderEvidenceStore } = await import("../src/storage/sqlite-provider-evidence-store.js");
    const store = new SqliteProviderEvidenceStore(":memory:");
    const event: ProviderEvidenceEvent = {
      receivedUtc: "2026-08-21T12:00:01.000Z",
      providerTimestampUtc: null,
      source: "projectx_lifecycle",
      eventType: "connected",
      generation: 1,
      accountId: 1,
      contractId: null,
      providerEntityId: "conn-1",
      rawPayload: {},
      normalizedPayload: {},
    };
    store.stageIdentityOutbox(event);
    assert.equal(store.loadPendingOutboxEvents().length, 1);
    store.appendBatch([event]);
    assert.equal(store.outboxPendingCount(), 0);
    store.close();
  });
});

describe("TS-REAUDIT-01 auth exposure gate", () => {
  it("blocks new exposure when auth is degraded", () => {
    const snap = snapshot();
    const gates = buildExecutionGates(
      snap,
      { maxQuoteAgeMs: 5_000, maxStateAgeMs: 120_000, maxIntentAgeMs: 120_000, estimatedRoundTurnFeesUsd: 0, slippageReserveTicks: 0 },
      healthyRecovery(),
      "armed",
      4,
      new Date("2026-08-21T12:00:00.000Z"),
      { degraded: true },
    );
    const gate = gates.find((entry) => entry.id === "new_exposure_technically_supported");
    assert.equal(gate?.passed, false);
    assert.match(gate?.detail ?? "", /auth_degraded/);
  });
});
