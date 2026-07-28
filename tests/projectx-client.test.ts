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
});
