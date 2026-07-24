import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { TopstepPolicyState, TradeIntent } from "../src/domain/models.js";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
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
    promptVersion: "glitch-topstep-v2",
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
      new Date("2026-07-21T12:00:00Z"),
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
    store.close();
  });

  it("enforces persistent intent identity and receipt replay", () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent();
    assert.equal(store.registerIntent(value, "2026-07-21T12:00:05Z"), true);
    assert.equal(store.registerIntent(value, "2026-07-21T12:00:06Z"), false);
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

  it("distinguishes prepared state from ambiguous provider submission", () => {
    const store = new SqliteExecutionStore(":memory:");
    const first = intent();
    store.registerIntent(first, "2026-07-21T12:00:05Z");
    store.prepareMutation(
      first.intentId,
      "place_order",
      { accountId: 101, contractId: "CON.F.US.MNQ.U26", type: 2, side: 0, size: 1 },
      "glt-first",
      "2026-07-21T12:00:06Z",
    );
    assert.equal(store.recoveryStatus().blockingAmbiguity, false);
    store.markMutationConfirmedNotSubmitted(first.intentId, "2026-07-21T12:00:07Z");

    const second = intent("00000000-0000-4000-8000-000000000002");
    store.registerIntent(second, "2026-07-21T12:00:08Z");
    store.prepareMutation(
      second.intentId,
      "place_order",
      { accountId: 101, contractId: "CON.F.US.MNQ.U26", type: 2, side: 0, size: 1 },
      "glt-second",
      "2026-07-21T12:00:09Z",
    );
    store.markMutationSubmitting(second.intentId, "2026-07-21T12:00:10Z");
    store.markMutationAmbiguous(second.intentId, "network_timeout", "2026-07-21T12:00:11Z");
    assert.equal(store.recoveryStatus().blockingAmbiguity, true);
    assert.equal(store.recoveryStatus().ambiguousMutations, 1);
    store.close();
  });
});
