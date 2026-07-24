import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  redactSecrets,
  SqliteProviderEvidenceStore,
} from "../src/storage/sqlite-provider-evidence-store.js";

describe("ProjectX provider evidence store", () => {
  it("persists monotonic raw and normalized evidence", () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    const first = store.append({
      recordedUtc: "2026-07-21T12:00:00Z",
      source: "projectx_user_stream",
      eventType: "order",
      generation: 2,
      accountId: 101,
      contractId: "CON.F.US.MNQ.U26",
      providerEntityId: "9001",
      rawPayload: { id: 9001, customTag: "glt-test" },
      normalizedPayload: { id: 9001, side: 0, size: 1 },
    });
    const second = store.append({
      recordedUtc: "2026-07-21T12:00:01Z",
      source: "projectx_market_stream",
      eventType: "quote",
      generation: 2,
      accountId: null,
      contractId: "CON.F.US.MNQ.U26",
      providerEntityId: "CON.F.US.MNQ.U26",
      rawPayload: { lastPrice: 20_000 },
      normalizedPayload: { lastPrice: 20_000, bestBid: 19_999.75, bestAsk: 20_000.25 },
    });

    assert.equal(first, 1);
    assert.equal(second, 2);
    assert.equal(store.count(), 2);
    const events = store.recent();
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.equal(events[0]?.providerEntityId, "9001");
    assert.equal((events[1]?.normalizedPayload as { bestAsk: number }).bestAsk, 20_000.25);
    store.close();
  });

  it("redacts nested credentials before persistence", () => {
    const redacted = redactSecrets({
      token: "top-secret",
      nested: {
        apiKey: "secret-key",
        authorization: "Bearer secret",
        harmless: "kept",
      },
      list: [{ password: "hidden" }],
    }) as {
      token: string;
      nested: { apiKey: string; authorization: string; harmless: string };
      list: Array<{ password: string }>;
    };

    assert.equal(redacted.token, "[REDACTED]");
    assert.equal(redacted.nested.apiKey, "[REDACTED]");
    assert.equal(redacted.nested.authorization, "[REDACTED]");
    assert.equal(redacted.nested.harmless, "kept");
    assert.equal(redacted.list[0]?.password, "[REDACTED]");
  });

  it("rejects unbounded evidence reads", () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    assert.throws(() => store.recent(0), /provider_evidence_limit_invalid/);
    assert.throws(() => store.recent(10_001), /provider_evidence_limit_invalid/);
    store.close();
  });
});
