import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ProjectXApiClient, ProjectXApiError } from "../src/projectx/client.js";
import { readLimitedResponseText, ResponseTooLargeError } from "../src/projectx/response-limit.js";
import type { ProjectXRestDiagnostic } from "../src/projectx/diagnostics.js";

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

  it("records sanitized diagnostics for timeout, HTTP classes, retry, and network errors", async () => {
    const diagnostics: ProjectXRestDiagnostic[] = [];
    let mode = "timeout";
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (mode === "timeout") {
        throw new DOMException("request timed out", "TimeoutError");
      }
      if (mode === "unauthorized") {
        return new Response("{}", { status: 401 });
      }
      if (mode === "rate_limit") {
        if (calls === 1) return new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
        return new Response(JSON.stringify({ success: true, errorCode: 0, errorMessage: null, positions: [] }), { status: 200 });
      }
      if (mode === "server") {
        return new Response("{}", { status: 503 });
      }
      throw new TypeError("fetch failed");
    });
    const client = new ProjectXApiClient({
      apiUrl: "https://api.example.com",
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
      rateLimitRetryMs: [0, 0],
      diagnostics: { rest: (event) => diagnostics.push(event), stream: () => undefined },
    });

    await assert.rejects(() => client.login());
    assert.equal(diagnostics.at(-1)?.error_class, "timeout");
    assert.equal(diagnostics.at(-1)?.status_http, null);
    assert.equal(diagnostics.at(-1)?.timed_out, true);
    assert.equal(diagnostics.at(-1)?.cancelled, false);

    (client as unknown as { token: string | null }).token = "session-token";
    mode = "unauthorized";
    await assert.rejects(() => client.searchOpenPositionsCollection(101));
    assert.equal(diagnostics.at(-1)?.error_class, "authentication");
    assert.equal(diagnostics.at(-1)?.status_http, 401);

    mode = "rate_limit";
    calls = 0;
    await client.searchOpenPositionsCollection(101);
    const rateLimit = diagnostics.find((event) => event.status_http === 429)!;
    assert.equal(rateLimit.error_class, "rate_limited");
    assert.equal(rateLimit.retry_performed, true);
    assert.equal(rateLimit.retry_after_ms, 2_000);

    mode = "server";
    await assert.rejects(() => client.searchOpenOrdersCollection(101));
    assert.equal(diagnostics.at(-1)?.error_class, "server_error");
    assert.equal(diagnostics.at(-1)?.status_http, 503);

    mode = "network";
    await assert.rejects(() => client.retrieveBars({
      contractId: "MNQ",
      live: true,
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
      unit: 2,
      unitNumber: 1,
      limit: 1,
      includePartialBar: false,
    }));
    assert.equal(diagnostics.at(-1)?.error_class, "network");
    assert.equal(diagnostics.at(-1)?.status_http, null);
    assert.doesNotMatch(JSON.stringify(diagnostics), /"(?:apiKey|authorization|token)"/i);
    for (const event of diagnostics) {
      assert.equal("headers" in event, false);
      assert.equal("payload" in event, false);
    }
  });
});
