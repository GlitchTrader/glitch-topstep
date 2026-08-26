import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { OrderInfo, TradeInfo, TradeIntent } from "../src/domain/models.js";
import { ProjectXOrderOwnershipService } from "../src/ownership/projectx-order-ownership.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";

const ACCOUNT_ID = 101;
const ACCOUNT_NAME = "TEST_ACCOUNT";
const CONTRACT_ID = "CON.F.US.MNQ.U26";
const INSTRUMENT = "MNQ";

function intent(
  intentId: string,
  action: "ENTER_LONG" | "ENTER_SHORT" = "ENTER_LONG",
  quantity = 1,
): TradeIntent {
  return {
    schemaVersion: "glitch.intent.v2",
    intentId,
    createdUtc: "2026-07-21T12:00:04Z",
    instrument: INSTRUMENT,
    account: ACCOUNT_NAME,
    operatorProfile: "glitch-topstep",
    action,
    confidence: 0.6,
    snapshotHash: "snapshot-hash",
    modelVersion: "test",
    promptVersion: "glitch-topstep-v17.1",
    reason: "Ownership fixture.",
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
    quantity,
    orderType: "MARKET",
    stopLoss: action === "ENTER_LONG" ? 19_990.25 : 20_010.25,
    takeProfit1: action === "ENTER_LONG" ? 20_020.25 : 19_980.25,
  };
}

function submittedEntry(
  store: SqliteExecutionStore,
  value: TradeIntent,
  providerOrderId: number,
): void {
  store.registerIntent(value, "2026-07-21T12:00:05Z");
  store.prepareMutation(
    value.intentId,
    "place_order",
    {
      accountId: ACCOUNT_ID,
      contractId: CONTRACT_ID,
      type: 2,
      side: value.action === "ENTER_LONG" ? 0 : 1,
      size: value.quantity,
    },
    `glt-${value.intentId}`,
    "2026-07-21T12:00:06Z",
  );
  store.markMutationSubmitting(value.intentId, "2026-07-21T12:00:07Z");
  store.markMutationSubmitted(value.intentId, providerOrderId, "2026-07-21T12:00:08Z");
}

function order(id: number, side = 0, size = 1): OrderInfo {
  return {
    id,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-07-21T12:00:08Z",
    updateTimestamp: "2026-07-21T12:00:09Z",
    status: 1,
    type: 2,
    side,
    size,
    limitPrice: null,
    stopPrice: null,
    customTag: `glt-00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  };
}

function trade(
  id: number,
  orderId: number,
  side = 0,
  size = 1,
  voided = false,
): TradeInfo {
  return {
    id,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-07-21T12:00:10Z",
    price: 20_000,
    profitAndLoss: null,
    fees: 1.25,
    side,
    size,
    voided,
    orderId,
  };
}

function withStores(
  action: (
    execution: SqliteExecutionStore,
    evidence: SqliteProviderEvidenceStore,
    ownership: ProjectXOrderOwnershipService,
  ) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "glitch-ownership-"));
  const executionPath = join(directory, "glitch-topstep.sqlite");
  const evidencePath = join(directory, "projectx-evidence.sqlite");
  const execution = new SqliteExecutionStore(executionPath);
  const evidence = new SqliteProviderEvidenceStore(evidencePath, {
    marketEventRetention: 100,
    marketPruneInterval: 10,
  });
  const ownership = new ProjectXOrderOwnershipService(
    executionPath,
    evidencePath,
    {
      accountId: ACCOUNT_ID,
      accountName: ACCOUNT_NAME,
      contractId: CONTRACT_ID,
      instrument: INSTRUMENT,
    },
    () => new Date("2026-07-21T12:01:00Z"),
  );
  try {
    action(execution, evidence, ownership);
  } finally {
    ownership.close();
    evidence.close();
    execution.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("ProjectX order ownership", () => {
  it("reports provider acknowledgement without inventing order or protection ownership", () => {
    withStores((execution, _evidence, ownership) => {
      const value = intent("00000000-0000-4000-8000-000000009001");
      submittedEntry(execution, value, 9001);
      const snapshot = ownership.current();
      assert.equal(snapshot.entries.length, 1);
      assert.equal(snapshot.entries[0]?.status, "provider_acknowledged");
      assert.equal(snapshot.entries[0]?.latestObservedOrder, null);
      assert.equal(snapshot.entries[0]?.protection.status, "unknown");
      assert.equal(snapshot.unresolved_entry_count, 1);
    });
  });

  it("attributes exact order and fill evidence only through provider IDs", () => {
    withStores((execution, evidence, ownership) => {
      const value = intent("00000000-0000-4000-8000-000000009002");
      submittedEntry(execution, value, 9002);
      const observedOrder = order(9002);
      observedOrder.customTag = `glt-${value.intentId}`;
      evidence.append({
        receivedUtc: "2026-07-21T12:00:09Z",
        providerTimestampUtc: observedOrder.updateTimestamp,
        source: "projectx_user_stream",
        eventType: "order",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: "9002",
        rawPayload: observedOrder,
        normalizedPayload: observedOrder,
      });
      const exactFill = trade(7001, 9002);
      evidence.append({
        receivedUtc: "2026-07-21T12:00:10Z",
        providerTimestampUtc: exactFill.creationTimestamp,
        source: "projectx_user_stream",
        eventType: "trade",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: "7001",
        relatedProviderEntityId: "9002",
        rawPayload: exactFill,
        normalizedPayload: exactFill,
      });
      const unrelated = trade(7002, 9999);
      evidence.append({
        receivedUtc: "2026-07-21T12:00:11Z",
        providerTimestampUtc: unrelated.creationTimestamp,
        source: "projectx_user_stream",
        eventType: "trade",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: "7002",
        relatedProviderEntityId: "9999",
        rawPayload: unrelated,
        normalizedPayload: unrelated,
      });

      const entry = ownership.current(1).entries[0]!;
      assert.equal(entry.status, "provider_observed");
      assert.equal(entry.latestObservedOrder?.id, 9002);
      assert.deepEqual(entry.fills.map((fill) => fill.trade.id), [7001]);
      assert.equal(entry.effectiveFilledQuantity, 1);
      assert.equal(entry.protection.status, "pending");
    });
  });

  it("binds protective child orders by custom tag when evidence is present", () => {
    withStores((execution, evidence, ownership) => {
      const value = intent("00000000-0000-4000-8000-000000009003");
      submittedEntry(execution, value, 9003);
      const entryOrder = order(9003);
      entryOrder.customTag = `glt-${value.intentId}`;
      const stopOrder = {
        ...order(9010, 1),
        type: 4,
        stopPrice: 19_990.25,
        customTag: `glt-${value.intentId}-SL`,
      };
      const targetOrder = {
        ...order(9011, 1),
        type: 1,
        limitPrice: 20_020.25,
        customTag: `glt-${value.intentId}-TP`,
      };
      evidence.append({
        receivedUtc: "2026-07-21T12:00:12Z",
        providerTimestampUtc: null,
        source: "projectx_rest",
        eventType: "open_orders_snapshot",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: null,
        rawPayload: null,
        normalizedPayload: [entryOrder, stopOrder, targetOrder],
      });
      const exactFill = trade(7003, 9003);
      evidence.append({
        receivedUtc: "2026-07-21T12:00:13Z",
        providerTimestampUtc: exactFill.creationTimestamp,
        source: "projectx_user_stream",
        eventType: "trade",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: "7003",
        relatedProviderEntityId: "9003",
        rawPayload: exactFill,
        normalizedPayload: exactFill,
      });
      const entry = ownership.current(1).entries[0]!;
      assert.equal(entry.latestObservedOrder?.id, 9003);
      assert.equal(entry.protection.status, "proven");
      assert.equal(entry.protection.stop.providerOrderId, 9010);
      assert.equal(entry.protection.target.providerOrderId, 9011);
      assert.equal(entry.issues.some((issue) => issue.includes("9010")), false);
    });
  });

  it("ignores cancelled brackets that only remain in older open-order snapshots", () => {
    withStores((execution, evidence, ownership) => {
      const closed = intent("00000000-0000-4000-8000-000000009031");
      const liveA = intent("00000000-0000-4000-8000-000000009032");
      const liveB = intent("00000000-0000-4000-8000-000000009033");
      submittedEntry(execution, closed, 9031);
      submittedEntry(execution, liveA, 9032);
      submittedEntry(execution, liveB, 9033);
      for (const [tradeId, orderId] of [[7031, 9031], [7032, 9032], [7033, 9033]] as const) {
        const fill = trade(tradeId, orderId);
        evidence.append({
          receivedUtc: `2026-07-21T12:00:${10 + tradeId - 7031}Z`,
          providerTimestampUtc: fill.creationTimestamp,
          source: "projectx_user_stream",
          eventType: "trade",
          generation: 1,
          accountId: ACCOUNT_ID,
          contractId: CONTRACT_ID,
          providerEntityId: String(tradeId),
          relatedProviderEntityId: String(orderId),
          rawPayload: fill,
          normalizedPayload: fill,
        });
      }

      const ghostStop = {
        ...order(9131, 1),
        type: 4,
        stopPrice: 19_990.25,
        customTag: `glt-${closed.intentId}-SL`,
      };
      const ghostTarget = {
        ...order(9132, 1),
        type: 1,
        limitPrice: 20_020.25,
        customTag: `glt-${closed.intentId}-TP`,
      };
      const liveStopA = {
        ...order(9141, 1),
        type: 4,
        stopPrice: 19_980.25,
        customTag: `glt-${liveA.intentId}-SL`,
      };
      const liveTargetA = {
        ...order(9142, 1),
        type: 1,
        limitPrice: 20_030.25,
        customTag: `glt-${liveA.intentId}-TP`,
      };
      const liveStopB = {
        ...order(9151, 1),
        type: 4,
        stopPrice: 19_970.25,
        customTag: `glt-${liveB.intentId}-SL`,
      };
      const liveTargetB = {
        ...order(9152, 1),
        type: 1,
        limitPrice: 20_040.25,
        customTag: `glt-${liveB.intentId}-TP`,
      };

      evidence.append({
        receivedUtc: "2026-07-21T12:01:00Z",
        providerTimestampUtc: null,
        source: "projectx_rest",
        eventType: "open_orders_snapshot",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: null,
        rawPayload: null,
        normalizedPayload: [ghostStop, ghostTarget, liveStopA, liveTargetA],
      });
      evidence.append({
        receivedUtc: "2026-07-21T12:02:00Z",
        providerTimestampUtc: null,
        source: "projectx_rest",
        eventType: "open_orders_snapshot",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: null,
        rawPayload: null,
        normalizedPayload: [liveStopA, liveTargetA, liveStopB, liveTargetB],
      });

      const snapshot = ownership.current(2);
      const byIntent = new Map(
        snapshot.tranches.map((tranche) => [tranche.intent_id, tranche.remaining_qty]),
      );
      assert.equal(byIntent.get(closed.intentId), 0);
      assert.equal(byIntent.get(liveA.intentId), 1);
      assert.equal(byIntent.get(liveB.intentId), 1);
      const closedEntry = snapshot.entries.find((entry) => entry.intentId === closed.intentId);
      assert.equal(closedEntry?.protection.stop.providerOrderId, null);
      assert.equal(closedEntry?.protection.target.providerOrderId, null);
    });
  });

  it("downgrades contradictory fills and overfills to incomplete", () => {
    withStores((execution, evidence, ownership) => {
      const value = intent("00000000-0000-4000-8000-000000009004");
      submittedEntry(execution, value, 9004);
      for (const fill of [trade(7101, 9004, 1, 1), trade(7102, 9004, 0, 1)]) {
        evidence.append({
          receivedUtc: `2026-07-21T12:00:${fill.id === 7101 ? "13" : "14"}Z`,
          providerTimestampUtc: fill.creationTimestamp,
          source: "projectx_user_stream",
          eventType: "trade",
          generation: 1,
          accountId: ACCOUNT_ID,
          contractId: CONTRACT_ID,
          providerEntityId: String(fill.id),
          relatedProviderEntityId: "9004",
          rawPayload: fill,
          normalizedPayload: fill,
        });
      }
      const entry = ownership.current().entries[0]!;
      assert.equal(entry.status, "incomplete");
      assert.ok(entry.issues.some((issue) => issue.startsWith("fill_side_mismatch")));
      assert.ok(entry.issues.some((issue) => issue.startsWith("fill_quantity_exceeds_order")));
    });
  });

  it("detects duplicate provider order IDs across durable intents", () => {
    withStores((execution, _evidence, ownership) => {
      const first = intent("00000000-0000-4000-8000-000000009005");
      submittedEntry(execution, first, 9005);
      execution.clearEntrySubmissionLatch(first.intentId);
      const second = intent("00000000-0000-4000-8000-000000009006");
      submittedEntry(execution, second, 9005);
      const snapshot = ownership.current();
      assert.equal(snapshot.entries.length, 2);
      assert.ok(snapshot.issues.includes("provider_order_id_shared:9005"));
      assert.ok(snapshot.entries.every((entry) => entry.status === "incomplete"));
    });
  });
});

describe("multi-tranche ownership reconstruction", () => {
  it("returns two tranches with correct remaining_qty after targeted partial exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-ownership-multi-tranche-"));
    const executionPath = join(directory, "glitch-topstep.sqlite");
    const evidencePath = join(directory, "projectx-evidence.sqlite");
    const execution = new SqliteExecutionStore(executionPath);
    const evidence = new SqliteProviderEvidenceStore(evidencePath, {
      marketEventRetention: 100,
      marketPruneInterval: 10,
    });
    const ownershipOptions = {
      accountId: ACCOUNT_ID,
      accountName: ACCOUNT_NAME,
      contractId: CONTRACT_ID,
      instrument: INSTRUMENT,
    };
    try {
      const first = intent("00000000-0000-4000-8000-000000009010");
      const second = intent("00000000-0000-4000-8000-000000009011");
      submittedEntry(execution, first, 9010);
      execution.clearEntrySubmissionLatch(first.intentId);
      submittedEntry(execution, second, 9011);

      for (const [value, orderId, fillId] of [
        [first, 9010, 7101],
        [second, 9011, 7102],
      ] as const) {
        const observedOrder = order(orderId);
        observedOrder.customTag = `glt-${value.intentId}`;
        evidence.append({
          receivedUtc: "2026-07-21T12:00:09Z",
          providerTimestampUtc: observedOrder.updateTimestamp,
          source: "projectx_user_stream",
          eventType: "order",
          generation: 1,
          accountId: ACCOUNT_ID,
          contractId: CONTRACT_ID,
          providerEntityId: String(orderId),
          rawPayload: observedOrder,
          normalizedPayload: observedOrder,
        });
        const exactFill = trade(fillId, orderId);
        evidence.append({
          receivedUtc: "2026-07-21T12:00:10Z",
          providerTimestampUtc: exactFill.creationTimestamp,
          source: "projectx_user_stream",
          eventType: "trade",
          generation: 1,
          accountId: ACCOUNT_ID,
          contractId: CONTRACT_ID,
          providerEntityId: String(fillId),
          relatedProviderEntityId: String(orderId),
          rawPayload: exactFill,
          normalizedPayload: exactFill,
        });
      }

      const exitIntent: TradeIntent = {
        schemaVersion: "glitch.intent.v2",
        intentId: "00000000-0000-4000-8000-000000009012",
        createdUtc: "2026-07-21T12:10:00Z",
        instrument: INSTRUMENT,
        account: ACCOUNT_NAME,
        operatorProfile: "glitch-topstep",
        action: "EXIT",
        confidence: 0.7,
        snapshotHash: "snapshot-hash",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v17.1",
        reason: "Exit second tranche.",
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
        targetIntentId: second.intentId,
      };
      execution.registerIntent(exitIntent, "2026-07-21T12:10:00Z");
      execution.prepareMutation(
        exitIntent.intentId,
        "place_order",
        { accountId: ACCOUNT_ID, contractId: CONTRACT_ID, type: 2, side: 1, size: 1 },
        `glt-${exitIntent.intentId}`,
        "2026-07-21T12:10:01Z",
      );
      execution.markMutationSubmitting(exitIntent.intentId, "2026-07-21T12:10:02Z");
      execution.markMutationSubmitted(exitIntent.intentId, 9410, "2026-07-21T12:10:03Z");

      // The targeted exit cancels the closed tranche's brackets; the survivor keeps working
      // stop and target orders, which is how the venue tells us who still owns the contract.
      evidence.append({
        receivedUtc: "2026-07-21T12:10:05Z",
        providerTimestampUtc: null,
        source: "projectx_rest",
        eventType: "open_orders_snapshot",
        generation: 1,
        accountId: ACCOUNT_ID,
        contractId: CONTRACT_ID,
        providerEntityId: null,
        rawPayload: null,
        normalizedPayload: [
          {
            ...order(9110, 1),
            type: 4,
            stopPrice: 19_990.25,
            customTag: `glt-${first.intentId}-SL`,
          },
          {
            ...order(9111, 1),
            type: 1,
            limitPrice: 20_020.25,
            customTag: `glt-${first.intentId}-TP`,
          },
        ],
      });

      execution.close();
      evidence.close();

      const ownership = new ProjectXOrderOwnershipService(
        executionPath,
        evidencePath,
        ownershipOptions,
        () => new Date("2026-07-21T12:11:00Z"),
      );
      const snapshot = ownership.current(1);
      ownership.close();

      assert.equal(snapshot.tranches.length, 2);
      const enterEntries = snapshot.entries.filter(
        (entry) => entry.action === "ENTER_LONG" || entry.action === "ENTER_SHORT",
      );
      assert.equal(enterEntries.length, 2);
      const trancheA = snapshot.tranches.find((row) => row.intent_id === first.intentId);
      const trancheB = snapshot.tranches.find((row) => row.intent_id === second.intentId);
      assert.equal(trancheA?.remaining_qty, 1);
      assert.equal(trancheB?.remaining_qty, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("provider evidence relationship migration", () => {
  it("backfills legacy trade orderId and recomputes its evidence hash", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-evidence-migration-"));
    const path = join(directory, "projectx-evidence.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE provider_evidence_migrations (
          version INTEGER PRIMARY KEY,
          applied_utc TEXT NOT NULL
        ) STRICT;
        CREATE TABLE provider_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          received_utc TEXT NOT NULL,
          provider_timestamp_utc TEXT,
          source TEXT NOT NULL,
          event_type TEXT NOT NULL,
          generation INTEGER NOT NULL,
          account_id INTEGER,
          contract_id TEXT,
          provider_entity_id TEXT,
          payload_hash TEXT NOT NULL,
          raw_payload_json TEXT NOT NULL,
          normalized_payload_json TEXT NOT NULL
        ) STRICT;
      `);
      const value = trade(7201, 9201);
      legacy.prepare(`
        INSERT INTO provider_events (
          received_utc, provider_timestamp_utc, source, event_type, generation,
          account_id, contract_id, provider_entity_id, payload_hash,
          raw_payload_json, normalized_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "2026-07-21T12:00:00Z",
        value.creationTimestamp,
        "projectx_user_stream",
        "trade",
        1,
        ACCOUNT_ID,
        CONTRACT_ID,
        String(value.id),
        "legacy-hash",
        JSON.stringify(value),
        JSON.stringify(value),
      );
      legacy.close();

      const migrated = new SqliteProviderEvidenceStore(path);
      const events = migrated.query({
        eventType: "trade",
        relatedProviderEntityId: "9201",
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.relatedProviderEntityId, "9201");
      assert.notEqual(events[0]?.payloadHash, "legacy-hash");
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
