import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ProjectXApiClient } from "../src/projectx/client.js";

const loginEnvelope = {
  success: true,
  errorCode: 0,
  errorMessage: null,
  token: "session-token",
};

describe("ProjectXApiClient", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("retries HTTP 429 before succeeding", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("{}", { status: 429 });
      }
      return new Response(JSON.stringify(loginEnvelope), { status: 200 });
    });

    const client = new ProjectXApiClient({
      apiUrl: "https://api.example.com",
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
      rateLimitRetryMs: [0, 0, 0],
    });
    const token = await client.login();
    assert.equal(token, "session-token");
    assert.equal(calls, 3);
  });

  it("returns REST collection envelopes alongside parsed items", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(loginEnvelope), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        errorCode: 0,
        errorMessage: null,
        token: "should-be-kept-until-store-redact",
        accounts: [{ id: 101, name: "TEST", balance: 1_000, canTrade: true, isVisible: true, simulated: true }],
      }), { status: 200 });
    });
    const client = new ProjectXApiClient({
      apiUrl: "https://api.example.com",
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
      rateLimitRetryMs: [0],
    });
    await client.login();
    const collection = await client.searchAccountsCollection(true);
    assert.equal(collection.items[0]?.id, 101);
    assert.equal(collection.envelope.success, true);
    assert.equal(collection.envelope.token, "should-be-kept-until-store-redact");
  });
});
