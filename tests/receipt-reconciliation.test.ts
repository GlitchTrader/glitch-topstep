import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionReceipt } from "../src/execution/coordinator.js";
import { reconcilePendingReceipts } from "../src/execution/receipt-reconciliation.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import type { OrderInfo } from "../src/domain/models.js";

describe("pending receipt reconciliation", () => {
  it("promotes a pending entry receipt to open_protected when child legs are observed", () => {
    const store = new SqliteExecutionStore(":memory:");
    const intentId = "00000000-0000-4000-8000-00000000c001";
    try {
      store.registerIntent({
        schemaVersion: "glitch.intent.v2",
        intentId,
        createdUtc: "2026-07-21T12:00:00Z",
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operatorProfile: "glitch-topstep",
        action: "ENTER_LONG",
        confidence: 0.6,
        snapshotHash: "snapshot",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v17.1",
        reason: "Entry.",
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
        stopLoss: 19_990,
        takeProfit1: 20_020,
      }, "2026-07-21T12:00:01Z");
      store.recordReceipt({
        schema_version: "glitch.direct.execution_receipt.v1",
        receipt_id: "receipt-1",
        recorded_utc: "2026-07-21T12:00:10Z",
        intent_id: intentId,
        mode: "armed",
        status: "pending",
        code: "entry_submitted_pending_reconciliation",
        order_id: 9001,
      });
      store.prepareMutation(
        intentId,
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
        `glt-${intentId}`,
        "2026-07-21T12:00:02Z",
      );
      store.markMutationSubmitting(intentId, "2026-07-21T12:00:03Z");
      store.markMutationSubmitted(intentId, 9001, "2026-07-21T12:00:04Z");

      const orders: OrderInfo[] = [
        {
          id: 9101,
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-07-21T12:00:08Z",
          updateTimestamp: "2026-07-21T12:00:09Z",
          status: 1,
          type: 4,
          side: 1,
          size: 1,
          limitPrice: null,
          stopPrice: 19_990,
          customTag: `glt-${intentId}-SL`,
        },
        {
          id: 9102,
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-07-21T12:00:08Z",
          updateTimestamp: "2026-07-21T12:00:09Z",
          status: 1,
          type: 1,
          side: 1,
          size: 1,
          limitPrice: 20_020,
          stopPrice: null,
          customTag: `glt-${intentId}-TP`,
        },
      ];
      const result = reconcilePendingReceipts(
        store,
        orders,
        101,
        "CON.F.US.MNQ.U26",
        true,
        "2026-07-21T12:00:11Z",
      );
      const receipt = store.receiptForIntent<ExecutionReceipt>(intentId);
      assert.equal(result.reconciled, 1);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.event, "bracket_verification_confirmed");
      assert.equal(receipt?.status, "open_protected");
      assert.equal(receipt?.code, "entry_open_with_proven_protection");
      const facts = store.executionFactsAfter(0) as unknown as {
        facts: Array<{ phase: string; diagnostics: { protection: { fidelity: string } } }>;
      };
      const confirmation = facts.facts.find((fact) => fact.phase === "protection_confirmed");
      assert.equal(confirmation?.diagnostics.protection.fidelity, "proven");
    } finally {
      store.close();
    }
  });

  it("marks entry protection verification failed after the timeout without child legs", () => {
    const store = new SqliteExecutionStore(":memory:");
    const intentId = "00000000-0000-4000-8000-00000000c002";
    try {
      store.registerIntent({
        schemaVersion: "glitch.intent.v2",
        intentId,
        createdUtc: "2026-07-21T12:00:00Z",
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operatorProfile: "glitch-topstep",
        action: "ENTER_LONG",
        confidence: 0.6,
        snapshotHash: "snapshot",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v17.1",
        reason: "Entry.",
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
        stopLoss: 19_990,
        takeProfit1: 20_020,
      }, "2026-07-21T12:00:01Z");
      store.recordReceipt({
        schema_version: "glitch.direct.execution_receipt.v1",
        receipt_id: "receipt-2",
        recorded_utc: "2026-07-21T12:00:10Z",
        intent_id: intentId,
        mode: "armed",
        status: "pending",
        code: "entry_submitted_pending_reconciliation",
        order_id: 9002,
        fill_observed_utc: "2026-07-21T12:00:10Z",
      });
      store.prepareMutation(
        intentId,
        "place_order",
        {
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          type: 2,
          side: 0,
          size: 1,
        },
        `glt-${intentId}`,
        "2026-07-21T12:00:02Z",
      );
      store.markMutationSubmitting(intentId, "2026-07-21T12:00:03Z");
      store.markMutationSubmitted(intentId, 9002, "2026-07-21T12:00:04Z");

      const result = reconcilePendingReceipts(
        store,
        [],
        101,
        "CON.F.US.MNQ.U26",
        true,
        "2026-07-21T12:00:41Z",
      );
      const receipt = store.receiptForIntent<ExecutionReceipt>(intentId);
      assert.equal(result.reconciled, 1);
      assert.equal(result.events[0]?.event, "bracket_verification_failed");
      assert.equal(receipt?.code, "entry_protection_verification_failed");
      assert.equal(receipt?.status, "pending");
    } finally {
      store.close();
    }
  });

  it("reconciles a confirmed partial EXIT when venue position matches the reduction record", () => {
    const store = new SqliteExecutionStore(":memory:");
    const entryIntentId = "00000000-0000-4000-8000-00000000c010";
    const exitIntentId = "00000000-0000-4000-8000-00000000c011";
    try {
      store.registerIntent({
        schemaVersion: "glitch.intent.v2",
        intentId: exitIntentId,
        createdUtc: "2026-07-21T12:00:00Z",
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operatorProfile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshotHash: "snapshot",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v17.1",
        reason: "Partial exit.",
        decisionAudit: {
          bullCase: "Bull.",
          bearCase: "Bear.",
          flatCase: "Flat.",
          aggressiveCase: "Aggressive.",
          conservativeCase: "Conservative.",
          decisiveEvidence: "Evidence.",
          disconfirmingEvidence: "Counter.",
          changeCondition: "Change.",
          finalChoice: "EXIT",
        },
        quantity: 1,
        targetIntentId: entryIntentId,
      }, "2026-07-21T12:00:01Z");
      store.beginProtectedReduction({
        reductionId: "00000000-0000-4000-8000-00000000c012",
        exitIntentId,
        targetIntentId: entryIntentId,
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        exitQuantity: 1,
        positionSizeBefore: 3,
        survivorStopOrderId: 9101,
        survivorTargetOrderId: 9102,
        nowUtc: "2026-07-21T12:00:02Z",
      });
      store.advanceProtectedReduction(
        exitIntentId,
        "reduction_submitting",
        "prepared_to_submitting",
        "2026-07-21T12:00:02Z",
      );
      store.advanceProtectedReduction(
        exitIntentId,
        "reduction_ambiguous",
        "exit_submitted_pending_survivor_proof",
        "2026-07-21T12:00:03Z",
        { providerExitOrderId: 9201 },
      );
      store.recordReceipt({
        schema_version: "glitch.direct.execution_receipt.v1",
        receipt_id: "receipt-partial",
        recorded_utc: "2026-07-21T12:00:10Z",
        intent_id: exitIntentId,
        mode: "armed",
        status: "pending",
        code: "partial_exit_submitted_pending_reconciliation",
        order_id: 9201,
      });
      store.prepareMutation(
        exitIntentId,
        "place_order",
        {
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          type: 2,
          side: 1,
          size: 1,
        },
        `glt-${exitIntentId}`,
        "2026-07-21T12:00:04Z",
      );
      store.markMutationSubmitting(exitIntentId, "2026-07-21T12:00:05Z");
      store.markMutationSubmitted(exitIntentId, 9201, "2026-07-21T12:00:06Z");

      const result = reconcilePendingReceipts(
        store,
        [],
        101,
        "CON.F.US.MNQ.U26",
        true,
        "2026-07-21T12:00:11Z",
        2,
      );
      const receipt = store.receiptForIntent<ExecutionReceipt>(exitIntentId);
      assert.equal(result.reconciled, 1);
      assert.equal(receipt?.status, "submitted");
      assert.equal(receipt?.code, "partial_exit_reconciled_pending_protection");
      assert.equal(store.hasExitMutationBlockingRearm(), false);
    } finally {
      store.close();
    }
  });

  it("keeps partial EXIT pending while the exit order is still working", () => {
    const store = new SqliteExecutionStore(":memory:");
    const entryIntentId = "00000000-0000-4000-8000-00000000c020";
    const exitIntentId = "00000000-0000-4000-8000-00000000c021";
    try {
      store.registerIntent({
        schemaVersion: "glitch.intent.v2",
        intentId: exitIntentId,
        createdUtc: "2026-07-21T12:00:00Z",
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operatorProfile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshotHash: "snapshot",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v17.1",
        reason: "Partial exit.",
        decisionAudit: {
          bullCase: "Bull.",
          bearCase: "Bear.",
          flatCase: "Flat.",
          aggressiveCase: "Aggressive.",
          conservativeCase: "Conservative.",
          decisiveEvidence: "Evidence.",
          disconfirmingEvidence: "Counter.",
          changeCondition: "Change.",
          finalChoice: "EXIT",
        },
        quantity: 1,
        targetIntentId: entryIntentId,
      }, "2026-07-21T12:00:01Z");
      store.beginProtectedReduction({
        reductionId: "00000000-0000-4000-8000-00000000c022",
        exitIntentId,
        targetIntentId: entryIntentId,
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        exitQuantity: 1,
        positionSizeBefore: 3,
        survivorStopOrderId: 9101,
        survivorTargetOrderId: 9102,
        nowUtc: "2026-07-21T12:00:02Z",
      });
      store.recordReceipt({
        schema_version: "glitch.direct.execution_receipt.v1",
        receipt_id: "receipt-partial-working",
        recorded_utc: "2026-07-21T12:00:10Z",
        intent_id: exitIntentId,
        mode: "armed",
        status: "pending",
        code: "partial_exit_submitted_pending_reconciliation",
        order_id: 9201,
      });
      store.prepareMutation(
        exitIntentId,
        "place_order",
        {
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          type: 2,
          side: 1,
          size: 1,
        },
        `glt-${exitIntentId}`,
        "2026-07-21T12:00:04Z",
      );
      store.markMutationSubmitting(exitIntentId, "2026-07-21T12:00:05Z");
      store.markMutationSubmitted(exitIntentId, 9201, "2026-07-21T12:00:06Z");

      const result = reconcilePendingReceipts(
        store,
        [{
          id: 9201,
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-07-21T12:00:08Z",
          updateTimestamp: "2026-07-21T12:00:09Z",
          status: 1,
          type: 2,
          side: 1,
          size: 1,
          limitPrice: null,
          stopPrice: null,
          customTag: `glt-${exitIntentId}`,
        }],
        101,
        "CON.F.US.MNQ.U26",
        true,
        "2026-07-21T12:00:11Z",
        2,
      );
      const receipt = store.receiptForIntent<ExecutionReceipt>(exitIntentId);
      assert.equal(result.reconciled, 0);
      assert.equal(receipt?.status, "pending");
      assert.equal(store.hasExitMutationBlockingRearm(), true);
    } finally {
      store.close();
    }
  });
});
