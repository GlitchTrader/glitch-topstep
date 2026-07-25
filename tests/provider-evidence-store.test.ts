import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  redactSecrets,
  SqliteProviderEvidenceStore,
} from "../src/storage/sqlite-provider-evidence-store.js";

describe("ProjectX provider evidence store", () => {
  it("persists monotonic hashed evidence across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-projectx-evidence-"));
    const path = join(directory, "evidence.sqlite");
    try {
      let store = new SqliteProviderEvidenceStore(path);
      const first = store.append({
        receivedUtc: "2026-07-21T12:00:00Z",
        providerTimestampUtc: "2026-07-21T11:59:59Z",
        source: "projectx_user_stream",
        eventType: "order",
        generation: 2,
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        providerEntityId: "9001",
        rawPayload: { id: 9001, customTag: "glt-test" },
        normalizedPayload: { id: 9001, side: 0, size: 1 },
      });
      assert.equal(first.sequence, 1);
      assert.match(first.payloadHash, /^[0-9a-f]{64}$/);
      store.close();

      store = new SqliteProviderEvidenceStore(path);
      const second = store.append({
        receivedUtc: "2026-07-21T12:00:01Z",
        providerTimestampUtc: "2026-07-21T12:00:01Z",
        source: "projectx_market_stream",
        eventType: "quote",
        generation: 2,
        accountId: null,
        contractId: "CON.F.US.MNQ.U26",
        providerEntityId: "CON.F.US.MNQ.U26",
        rawPayload: { lastPrice: 20_000 },
        normalizedPayload: {
          lastPrice: 20_000,
          bestBid: 19_999.75,
          bestAsk: 20_000.25,
        },
      });
      assert.equal(second.sequence, 2);
      assert.deepEqual(store.recent().map((event) => event.sequence), [1, 2]);
      assert.deepEqual(store.status(), {
        eventCount: 2,
        latestSequence: 2,
        latestReceivedUtc: "2026-07-21T12:00:01Z",
      });
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redacts nested credential key variants before persistence", () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    const event = store.append({
      receivedUtc: "2026-07-21T12:00:00Z",
      providerTimestampUtc: null,
      source: "projectx_rest",
      eventType: "sanitization_fixture",
      generation: 1,
      accountId: null,
      contractId: null,
      providerEntityId: null,
      rawPayload: {
        token: "top-secret",
        accessToken: "access-secret",
        new_token: "renewed-secret",
        nested: {
          apiKey: "secret-key",
          authorization: "Bearer secret",
          providerCredential: "credential-secret",
          harmless: "kept",
        },
        list: [{ password: "hidden" }],
      },
      normalizedPayload: null,
    });
    const redacted = event.rawPayload as {
      token: string;
      accessToken: string;
      new_token: string;
      nested: {
        apiKey: string;
        authorization: string;
        providerCredential: string;
        harmless: string;
      };
      list: Array<{ password: string }>;
    };
    assert.equal(redacted.token, "[REDACTED]");
    assert.equal(redacted.accessToken, "[REDACTED]");
    assert.equal(redacted.new_token, "[REDACTED]");
    assert.equal(redacted.nested.apiKey, "[REDACTED]");
    assert.equal(redacted.nested.authorization, "[REDACTED]");
    assert.equal(redacted.nested.providerCredential, "[REDACTED]");
    assert.equal(redacted.nested.harmless, "kept");
    assert.equal(redacted.list[0]?.password, "[REDACTED]");
    store.close();
  });

  it("rejects unbounded evidence reads", () => {
    const store = new SqliteProviderEvidenceStore(":memory:");
    assert.throws(() => store.recent(0), /provider_evidence_limit_invalid/);
    assert.throws(() => store.recent(1_001), /provider_evidence_limit_invalid/);
    store.close();
  });

  it("redacts objects without mutating the caller payload", () => {
    const input = { nested: { apiKey: "secret", safe: "value" } };
    const output = redactSecrets(input) as typeof input;
    assert.equal(output.nested.apiKey, "[REDACTED]");
    assert.equal(output.nested.safe, "value");
    assert.equal(input.nested.apiKey, "secret");
  });
});
