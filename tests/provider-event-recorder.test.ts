import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderEvidenceEvent } from "../src/domain/provider-evidence.js";
import {
  ProviderRestSnapshotRecorder,
  recordProviderEventBeforeApply,
  recordProviderLifecycleEvent,
} from "../src/projectx/provider-event-recorder.js";

describe("ProjectX provider event recorder", () => {
  it("persists parsed evidence before mutating state", () => {
    const order: string[] = [];
    const events: ProviderEvidenceEvent[] = [];
    const normalized = recordProviderEventBeforeApply({
      sink: {
        append: (event) => {
          order.push("persist");
          events.push(event);
        },
      },
      receivedUtc: "2026-07-21T12:00:00Z",
      source: "projectx_user_stream",
      eventType: "order",
      generation: 3,
      rawPayload: { id: 9001 },
      parse: () => {
        order.push("parse");
        return { id: 9001, accountId: 101, contractId: "MNQ" };
      },
      identity: (value) => ({
        accountId: value.accountId,
        contractId: value.contractId,
        providerEntityId: String(value.id),
        providerTimestampUtc: null,
      }),
      apply: () => {
        order.push("apply");
      },
    });

    assert.deepEqual(order, ["parse", "persist", "apply"]);
    assert.equal(normalized.id, 9001);
    assert.equal(events[0]?.providerEntityId, "9001");
    assert.deepEqual(events[0]?.normalizedPayload, normalized);
  });

  it("does not mutate state when evidence persistence fails", () => {
    let applied = false;
    assert.throws(() => recordProviderEventBeforeApply({
      sink: {
        append: () => {
          throw new Error("disk unavailable");
        },
      },
      receivedUtc: "2026-07-21T12:00:00Z",
      source: "projectx_market_stream",
      eventType: "quote",
      generation: 1,
      rawPayload: { lastPrice: 20_000 },
      parse: () => ({ contractId: "MNQ", lastPrice: 20_000 }),
      identity: (value) => ({
        accountId: null,
        contractId: value.contractId,
        providerEntityId: value.contractId,
        providerTimestampUtc: null,
      }),
      apply: () => {
        applied = true;
      },
    }), /disk unavailable/);
    assert.equal(applied, false);
  });

  it("records lifecycle events without inventing normalized state", () => {
    const events: ProviderEvidenceEvent[] = [];
    recordProviderLifecycleEvent(
      { append: (event) => events.push(event) },
      {
        receivedUtc: "2026-07-21T12:00:00Z",
        providerTimestampUtc: null,
        eventType: "market_reconnecting",
        generation: 4,
        accountId: null,
        contractId: "MNQ",
        providerEntityId: null,
        rawPayload: { name: "Error", message: "lost" },
      },
    );
    assert.equal(events[0]?.source, "projectx_lifecycle");
    assert.equal(events[0]?.normalizedPayload, null);
  });

  it("deduplicates unchanged canonical REST snapshots", () => {
    const events: ProviderEvidenceEvent[] = [];
    const recorder = new ProviderRestSnapshotRecorder({
      append: (event) => events.push(event),
    });
    const base = {
      receivedUtc: "2026-07-21T12:00:00Z",
      eventType: "accounts_snapshot",
      generation: 1,
      accountId: 101,
      contractId: null,
    };

    assert.equal(recorder.recordIfChanged({
      ...base,
      normalizedPayload: [{ id: 101, name: "TEST", balance: 1_000 }],
    }), true);
    assert.equal(recorder.recordIfChanged({
      ...base,
      receivedUtc: "2026-07-21T12:00:03Z",
      normalizedPayload: [{ balance: 1_000, name: "TEST", id: 101 }],
    }), false);
    assert.equal(recorder.recordIfChanged({
      ...base,
      receivedUtc: "2026-07-21T12:00:06Z",
      normalizedPayload: [{ id: 101, name: "TEST", balance: 1_100 }],
    }), true);

    assert.equal(events.length, 2);
    assert.equal(events[0]?.receivedUtc, "2026-07-21T12:00:00Z");
    assert.equal(events[1]?.receivedUtc, "2026-07-21T12:00:06Z");
  });

  it("does not cache a REST snapshot when persistence fails", () => {
    let fail = true;
    let persisted = 0;
    const recorder = new ProviderRestSnapshotRecorder({
      append: () => {
        if (fail) {
          throw new Error("disk unavailable");
        }
        persisted += 1;
      },
    });
    const snapshot = {
      receivedUtc: "2026-07-21T12:00:00Z",
      eventType: "positions_snapshot",
      generation: 1,
      accountId: 101,
      contractId: "MNQ",
      normalizedPayload: [],
    };
    assert.throws(() => recorder.recordIfChanged(snapshot), /disk unavailable/);
    fail = false;
    assert.equal(recorder.recordIfChanged(snapshot), true);
    assert.equal(persisted, 1);
  });
});
