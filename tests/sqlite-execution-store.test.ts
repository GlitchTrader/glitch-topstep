import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { describe, it } from "node:test";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { TopstepPolicyState, TradeIntent } from "../src/domain/models.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { shouldClearStaleEntrySubmissionLatch } from "../src/execution/entry-submission-latch.js";
import { snapshot } from "./fixtures.js";

const policy: TopstepPolicyState = {
  accountStage: "express_funded_standard",
  lossModel: "express_funded_eod",
  authority: "operator_configured",
  verifiedAtUtc: null,
  startingBalance: 50_000,
  initialMaximumLoss: 2_000,
  highestEndOfDayBalance: 0,
  lossFloorLockedAtZero: false,
  payoutProcessed: false,
  operatorProvidedLossFloorUsd: null,
  maxContracts: 5,
};

const recovery: ExecutionRecoveryStatus = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

function intent(id = "00000000-0000-4000-8000-000000000001"): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: id,
    createdUtc: "2026-07-21T12:00:04Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action: "ENTER_LONG",
    confidence: 0.6,
    snapshotHash: "snapshot-hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v16",
    reason: "Test.",
    decisionAudit: {
      bullCase: "Bull.",
      bearCase: "Bear.",
      flatCase: "Flat.",
      aggressiveCase: "Aggressive.",
      conservativeCase: "Conservative.",
      decisiveEvidence: "Evidence.",
      disconfirmingEvidence: "Counter.",
      changeCondition: "Change.",
      finalChoice: "ENTER_LONG",
    },
    quantity: 1,
    orderType: "MARKET",
    stopLoss: 19_990.25,
    takeProfit1: 20_020.25,
  };
}

describe("SQLite execution store", () => {
  it("persists and invalidates issued packet leases", () => {
    const store = new SqliteExecutionStore(":memory:");
    const packet = buildDecisionPacket(
      snapshot(),
      policy,
      {
        estimatedRoundTurnFeesUsd: 2.5,
        slippageReserveTicks: 2,
        maxQuoteAgeMs: 5_000,
        maxStateAgeMs: 5_000,
        maxIntentAgeMs: 300_000,
      },
      recovery,
      "MNQ",
      "shadow",
      300_000,
      new Date("2026-07-21T12:00:05Z"),
    );
    store.recordIssuedPacket(packet);
    assert.equal(
      store.resolveIssuedPacket(packet.market.snapshot_hash, "2026-07-21T12:01:00Z")?.packet_id,
      packet.packet_id,
    );
    store.invalidateIssuedPackets("2026-07-21T12:01:01Z");
    assert.equal(
      store.resolveIssuedPacket(packet.market.snapshot_hash, "2026-07-21T12:01:02Z"),
      null,
    );
    const pruned = store.pruneExpiredPackets("2099-01-01T00:00:00Z");
    assert.equal(pruned, 1);
    store.close();
  });

  it("enforces persistent intent identity and receipt replay", () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent();
    assert.deepEqual(store.registerIntent(value, "2026-07-21T12:00:05Z"), { status: "claimed" });
    assert.deepEqual(store.registerIntent(value, "2026-07-21T12:00:06Z"), { status: "duplicate" });
    store.recordReceipt({
      receipt_id: "receipt-1",
      recorded_utc: "2026-07-21T12:00:07Z",
      intent_id: value.intentId,
      status: "shadowed",
      code: "entry_verified_not_submitted",
    });
    const receipt = store.receiptForIntent<{ code: string }>(value.intentId);
    assert.equal(receipt?.code, "entry_verified_not_submitted");
    store.close();
  });

  it("rejects the same intent_id with a different body hash", () => {
    const store = new SqliteExecutionStore(":memory:");
    const first = intent();
    const second = intent();
    second.reason = "Different body.";
    assert.deepEqual(store.registerIntent(first, "2026-07-21T12:00:05Z"), { status: "claimed" });
    assert.deepEqual(store.registerIntent(second, "2026-07-21T12:00:06Z"), { status: "conflict" });
    store.close();
  });

  it("atomically latches one entry until provider state settles", () => {
    const store = new SqliteExecutionStore(":memory:");
    const first = intent();
    store.registerIntent(first, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      first.intentId,
      "place_order",
      {
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        type: 2,
        side: 0,
        size: 1,
        stopLossBracket: { ticks: -10, type: 4 },
        takeProfitBracket: { ticks: 10, type: 1 },
      },
      "glt-first",
      "2026-07-21T12:00:06Z",
    );
    assert.equal(store.entrySubmissionIntentId(), first.intentId);
    assert.equal(store.recoveryStatus().entrySubmissionPending, true);
    assert.equal(store.recoveryStatus().blockingNewExposure, true);

    const second = intent("00000000-0000-4000-8000-000000000002");
    store.registerIntent(second, "2026-07-21T12:00:07Z");
    assert.throws(() => store.prepareMutation(
      second.intentId,
      "place_order",
      {
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        type: 2,
        side: 0,
        size: 1,
        stopLossBracket: { ticks: -10, type: 4 },
        takeProfitBracket: { ticks: 10, type: 1 },
      },
      "glt-second",
      "2026-07-21T12:00:08Z",
    ), /entry_submission_pending/);

    store.markMutationConfirmedNotSubmitted(first.intentId, "2026-07-21T12:00:09Z");
    assert.equal(store.recoveryStatus().entrySubmissionPending, false);
    store.prepareMutation(
      second.intentId,
      "place_order",
      {
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        type: 2,
        side: 0,
        size: 1,
        stopLossBracket: { ticks: -10, type: 4 },
        takeProfitBracket: { ticks: 10, type: 1 },
      },
      "glt-second",
      "2026-07-21T12:00:10Z",
    );
    store.markMutationSubmitting(second.intentId, "2026-07-21T12:00:11Z");
    store.markMutationAmbiguous(second.intentId, "network_timeout", "2026-07-21T12:00:12Z");
    assert.equal(store.recoveryStatus().blockingAmbiguity, true);
    assert.equal(store.recoveryStatus().blockingNewExposure, true);
    assert.equal(store.recoveryStatus().ambiguousMutations, 1);
    store.close();
  });

  it("treats markMutationSubmitted as idempotent when already submitted", () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000006");
    value.action = "EXIT";
    store.registerIntent(value, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      value.intentId,
      "close_position",
      { accountId: 101, contractId: "CON.F.US.MNQ.U26" },
      null,
      "2026-07-21T12:00:06Z",
    );
    store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
    store.markMutationSubmitted(value.intentId, null, "2026-07-21T12:00:08Z");
    store.markMutationSubmitted(value.intentId, null, "2026-07-21T12:00:09Z");
    assert.equal(store.mutationForIntent(value.intentId)?.state, "submitted");
    store.close();
  });

  it("reopens a file-backed store with unchanged recovery state (TS-R1-02 smoke)", () => {
    const path = join(tmpdir(), `ts-r1-restart-${randomUUID()}.sqlite`);
    const value = intent("00000000-0000-4000-8000-000000000007");
    const first = new SqliteExecutionStore(path);
    first.registerIntent(value, "2026-07-21T12:00:05Z");
    first.prepareMutation(
      value.intentId,
      "modify_order",
      { accountId: 101, orderId: 42, stopPrice: 20_000.25 },
      "glt-7-SL",
      "2026-07-21T12:00:06Z",
    );
    first.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
    first.markMutationAmbiguous(value.intentId, "transport_timeout", "2026-07-21T12:00:08Z");
    first.close();

    const reopened = new SqliteExecutionStore(path);
    assert.equal(reopened.mutationForIntent(value.intentId)?.state, "ambiguous");
    assert.equal(reopened.recoveryStatus().blockingAmbiguity, true);
    assert.equal(reopened.recoveryStatus().blockingNewExposure, true);
    reopened.close();
    unlinkSync(path);
  });

  it("simulates stale submitted latch unblock after flat venue TTL", () => {
    const store = new SqliteExecutionStore(":memory:");
    const first = intent();
    store.registerIntent(first, "2026-08-07T19:06:50.000Z");
    store.prepareMutation(
      first.intentId,
      "place_order",
      {
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        type: 2,
        side: 0,
        size: 1,
        stopLossBracket: { ticks: -10, type: 4 },
        takeProfitBracket: { ticks: 10, type: 1 },
      },
      "glt-first",
      "2026-08-07T19:06:50.274Z",
    );
    store.markMutationSubmitting(first.intentId, "2026-08-07T19:06:50.400Z");
    store.markMutationSubmitted(first.intentId, 42, "2026-08-07T19:06:50.492Z");
    assert.equal(store.recoveryStatus().entrySubmissionPending, true);

    const mutation = store.mutationForIntent(first.intentId)!;
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        mutation,
        "2026-08-07T19:08:00.000Z",
        300_000,
        true,
        false,
        false,
      ),
      false,
    );
    assert.equal(
      shouldClearStaleEntrySubmissionLatch(
        mutation,
        "2026-08-07T19:12:00.000Z",
        300_000,
        true,
        false,
        false,
      ),
      true,
    );
    store.clearEntrySubmissionLatch(first.intentId);
    assert.equal(store.recoveryStatus().entrySubmissionPending, false);
    assert.equal(store.recoveryStatus().blockingNewExposure, false);
    store.close();
  });
});
