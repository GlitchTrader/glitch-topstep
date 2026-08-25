import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ProjectXApiClient, ProjectXApiError } from "../src/projectx/client.js";
import { readLimitedResponseText, ResponseTooLargeError } from "../src/projectx/response-limit.js";

const loginEnvelope = {
  success: true,
  errorCode: 0,
  errorMessage: null,
  token: "session-token",
};

describe("ProjectX response limit", () => {
  it("rejects oversized streamed responses", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const response = new Response(body, { status: 200 });
    await assert.rejects(
      () => readLimitedResponseText(response, 1500),
      (error: unknown) => error instanceof ResponseTooLargeError,
    );
  });
});

describe("ProjectXApiClient", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("does not retry mutation placeOrder on HTTP 429", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(loginEnvelope), { status: 200 });
      }
      return new Response("{}", { status: 429 });
    });

    const client = new ProjectXApiClient({
      apiUrl: "https://api.example.com",
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
      rateLimitRetryMs: [0, 0, 0],
    });
    await client.login();
    await assert.rejects(
      () => client.placeOrder({
        accountId: 1,
        contractId: "MNQ",
        type: 1,
        side: 0,
        size: 1,
      } as never),
      (error: unknown) => error instanceof ProjectXApiError && error.status === 429,
    );
    assert.equal(calls, 2);
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
