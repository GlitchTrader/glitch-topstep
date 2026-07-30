import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { EntryOrderOwnership } from "../src/domain/order-ownership.js";
import type { TradeIntent } from "../src/domain/models.js";
import {
  allocateExitQuantities,
  buildTranches,
  querySubmittedExitAllocations,
} from "../src/ownership/tranches.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

const ENTRY_A = "00000000-0000-4000-8000-00000000a001";
const ENTRY_B = "00000000-0000-4000-8000-00000000a002";

function entry(
  intentId: string,
  filledQty: number,
  providerOrderId: number,
): EntryOrderOwnership {
  return {
    intentId,
    account: "TEST_ACCOUNT",
    instrument: "MNQ",
    action: "ENTER_LONG",
    quantity: filledQty,
    plannedStopLoss: 19_990,
    plannedTakeProfit: 20_020,
    customTag: `glt-${intentId}`,
    providerOrderId,
    status: "provider_observed",
    orderEvidenceSequences: [1],
    latestObservedOrder: null,
    fills: [],
    effectiveFilledQuantity: filledQty,
    protection: {
      status: "proven",
      reason: "provider_child_orders_bound_by_custom_tag",
      stop: {
        customTag: `glt-${intentId}-SL`,
        providerOrderId: providerOrderId + 10,
        price: 19_990,
        observedOrder: null,
      },
      target: {
        customTag: `glt-${intentId}-TP`,
        providerOrderId: providerOrderId + 11,
        price: 20_020,
        observedOrder: null,
      },
    },
    issues: [],
  };
}

function exitIntent(
  intentId: string,
  quantity: number,
  targetIntentId?: string,
): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId,
    createdUtc: "2026-07-21T12:10:00Z",
    instrument: "MNQ",
    account: "TEST_ACCOUNT",
    operatorProfile: "glitch-topstep",
    action: "EXIT",
    confidence: 0.7,
    snapshotHash: "snapshot-hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v2",
    reason: "Scale out.",
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
    quantity,
    ...(targetIntentId === undefined ? {} : { targetIntentId }),
  };
}

function submittedPartialExit(
  store: SqliteExecutionStore,
  value: TradeIntent,
  providerOrderId: number,
): void {
  store.registerIntent(value, value.createdUtc);
  store.prepareMutation(
    value.intentId,
    "place_order",
    {
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      type: 2,
      side: 1,
      size: value.quantity,
    },
    `glt-${value.intentId}`,
    value.createdUtc,
  );
  store.markMutationSubmitting(value.intentId, value.createdUtc);
  store.markMutationSubmitted(value.intentId, providerOrderId, value.createdUtc);
}

describe("tranche projection", () => {
  it("builds tranches from multiple filled entries", () => {
    const createdUtc = new Map([
      [ENTRY_A, "2026-07-21T12:00:05Z"],
      [ENTRY_B, "2026-07-21T12:00:06Z"],
    ]);
    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001), entry(ENTRY_B, 2, 9002)],
      createdUtc,
    );
    assert.equal(tranches.length, 2);
    assert.equal(tranches[0]?.intent_id, ENTRY_A);
    assert.equal(tranches[0]?.filled_qty, 1);
    assert.equal(tranches[0]?.remaining_qty, 1);
    assert.equal(tranches[0]?.entry_order_id, 9001);
    assert.equal(tranches[1]?.intent_id, ENTRY_B);
    assert.equal(tranches[1]?.filled_qty, 2);
    assert.equal(tranches[1]?.remaining_qty, 2);
    assert.equal(tranches[0]?.protection.stop.provider_order_id, 9011);
  });

  it("allocates untargeted partial exits FIFO by created_utc", () => {
    const allocated = allocateExitQuantities(
      [
        { intentId: ENTRY_A, filledQty: 1, createdUtc: "2026-07-21T12:00:05Z" },
        { intentId: ENTRY_B, filledQty: 2, createdUtc: "2026-07-21T12:00:06Z" },
      ],
      [{
        exitIntentId: "00000000-0000-4000-8000-00000000e001",
        quantity: 2,
        targetIntentId: null,
        createdUtc: "2026-07-21T12:10:00Z",
      }],
    );
    assert.equal(allocated.get(ENTRY_A), 1);
    assert.equal(allocated.get(ENTRY_B), 1);

    const tranches = buildTranches(
      [entry(ENTRY_A, 1, 9001), entry(ENTRY_B, 2, 9002)],
      new Map([
        [ENTRY_A, "2026-07-21T12:00:05Z"],
        [ENTRY_B, "2026-07-21T12:00:06Z"],
      ]),
      [{
        exitIntentId: "00000000-0000-4000-8000-00000000e001",
        quantity: 2,
        targetIntentId: null,
        createdUtc: "2026-07-21T12:10:00Z",
      }],
    );
    assert.equal(tranches[0]?.remaining_qty, 0);
    assert.equal(tranches[1]?.remaining_qty, 1);
  });

  it("reads submitted exit allocations from the execution store", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-tranches-exit-"));
    const path = join(directory, "glitch-topstep.sqlite");
    const store = new SqliteExecutionStore(path);
    try {
      submittedPartialExit(
        store,
        exitIntent("00000000-0000-4000-8000-00000000e002", 1, ENTRY_B),
        9401,
      );
      store.close();
      const database = new DatabaseSync(path);
      try {
        const exits = querySubmittedExitAllocations(database);
        assert.equal(exits.length, 1);
        assert.equal(exits[0]?.quantity, 1);
        assert.equal(exits[0]?.targetIntentId, ENTRY_B);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
