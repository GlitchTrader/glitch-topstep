import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TradeAction, TradeIntent } from "../src/domain/models.js";
import { recoverExecutionMutations } from "../src/execution/recovery.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

function intent(id: string, action: TradeAction): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId: id,
    createdUtc: "2026-07-21T12:00:04Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action,
    confidence: 0.6,
    snapshotHash: "snapshot-hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v17",
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
      finalChoice: action,
    },
    ...(action === "ENTER_LONG"
      ? {
          quantity: 1,
          orderType: "MARKET" as const,
          stopLoss: 19_990.25,
          takeProfit1: 20_020.25,
        }
      : {}),
  };
}

describe("orphan intent recovery", () => {
  it("proves an entry intent with no outbox never reached ProjectX", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000101", "ENTER_LONG");
    store.registerIntent(value, "2026-07-21T12:00:05Z");

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => { throw new Error("provider lookup must not run"); } },
      101,
      "CON.F.US.MNQ.U26",
      [],
      new Date("2026-07-21T12:01:00Z"),
    );

    assert.equal(result.resolved, 1);
    assert.equal(result.resolutions[0]?.operation, "place_order");
    assert.equal(result.resolutions[0]?.outcome, "confirmed_not_submitted");
    assert.equal(result.resolutions[0]?.code, "intent_confirmed_not_submitted_without_outbox");
    store.close();
  });

  it("reconstructs a no-op intent as ignored rather than rejected", async () => {
    const store = new SqliteExecutionStore(":memory:");
    const value = intent("00000000-0000-4000-8000-000000000102", "NOTHING");
    store.registerIntent(value, "2026-07-21T12:00:05Z");

    const result = await recoverExecutionMutations(
      store,
      { searchOrders: async () => [] },
      101,
      "CON.F.US.MNQ.U26",
      [],
      new Date("2026-07-21T12:01:00Z"),
    );

    assert.equal(result.resolutions[0]?.operation, "no_mutation");
    assert.equal(result.resolutions[0]?.outcome, "ignored");
    assert.equal(result.resolutions[0]?.code, "no_op_receipt_reconstructed_after_restart");
    store.close();
  });
});
