import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";

const event = (receivedUtc: string, status = 1) => ({
  receivedUtc,
  providerTimestampUtc: "2026-07-21T10:30:00Z",
  source: "projectx_rest" as const,
  eventType: "historical_order",
  generation: 1,
  accountId: 101,
  contractId: "CON.F.US.MNQ.U26",
  providerEntityId: "9001",
  relatedProviderEntityId: null,
  rawPayload: null,
  normalizedPayload: { id: 9001, status },
});

describe("historical evidence heads", () => {
  it("survive reopen and suppress unchanged content independent of receipt time", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-history-head-"));
    const path = join(directory, "evidence.sqlite");
    try {
      let store = new SqliteProviderEvidenceStore(path);
      assert.equal(
        store.appendIfChanged(
          "historical-order:101:9001",
          event("2026-07-21T12:00:00Z"),
        ).appended,
        true,
      );
      store.close();
      store = new SqliteProviderEvidenceStore(path);
      assert.equal(
        store.appendIfChanged(
          "historical-order:101:9001",
          event("2026-07-21T12:01:00Z"),
        ).appended,
        false,
      );
      assert.equal(
        store.appendIfChanged(
          "historical-order:101:9001",
          event("2026-07-21T12:02:00Z", 2),
        ).appended,
        true,
      );
      assert.deepEqual(
        store.query({ eventType: "historical_order" })
          .map((item) => (item.normalizedPayload as { status: number }).status),
        [1, 2],
      );
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not regress a durable head to an older provider version", () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    try {
      const newer = {
        ...event("2026-07-21T12:02:00Z", 2),
        providerTimestampUtc: "2026-07-21T12:02:00Z",
      };
      const older = {
        ...event("2026-07-21T12:03:00Z", 1),
        providerTimestampUtc: "2026-07-21T12:01:00Z",
      };
      assert.equal(
        store.appendIfChanged("historical-order:101:9001", newer).appended,
        true,
      );
      assert.equal(
        store.appendIfChanged("historical-order:101:9001", older).appended,
        false,
      );
      assert.deepEqual(
        store.query({ eventType: "historical_order" })
          .map((item) => (item.normalizedPayload as { status: number }).status),
        [2],
      );
    } finally {
      store.close();
    }
  });

  it("allows a same-timestamp correction while suppressing identical content", () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    try {
      const first = event("2026-07-21T12:00:00Z", 1);
      const correction = event("2026-07-21T12:01:00Z", 2);
      assert.equal(store.appendIfChanged("historical-order:101:9001", first).appended, true);
      assert.equal(store.appendIfChanged("historical-order:101:9001", first).appended, false);
      assert.equal(store.appendIfChanged("historical-order:101:9001", correction).appended, true);
    } finally {
      store.close();
    }
  });
});
