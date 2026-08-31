import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it, after, before } from "node:test";
import {
  ProjectXAuthManager,
  projectXAuthBackoffDelayMs,
  PROJECTX_AUTH_BACKOFF_MAX_MS,
} from "../src/projectx/auth-manager.js";

function jsonResponse(body: unknown, status = 200): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

describe("TS-AUDIT-06 ProjectXAuthManager", () => {
  let server: Server;
  let baseUrl = "";
  let loginCalls = 0;
  let validateCalls = 0;

  before(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "";
      if (path === "/api/Auth/loginKey") {
        loginCalls += 1;
        const payload = jsonResponse({
          success: true,
          errorCode: 0,
          errorMessage: null,
          token: `session-${loginCalls}`,
        });
        response.writeHead(payload.status, { "Content-Type": "application/json" });
        response.end(payload.body);
        return;
      }
      if (path === "/api/Auth/validate") {
        validateCalls += 1;
        const payload = jsonResponse({
          success: true,
          errorCode: 0,
          errorMessage: null,
          newToken: `rotated-${validateCalls}`,
        });
        response.writeHead(payload.status, { "Content-Type": "application/json" });
        response.end(payload.body);
        return;
      }
      if (path === "/api/Account/search") {
        const auth = request.headers.authorization ?? "";
        if (!auth.startsWith("Bearer session-") && !auth.startsWith("Bearer rotated-")) {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ success: false, errorCode: 401, errorMessage: "expired" }));
          return;
        }
        const payload = jsonResponse({ success: true, errorCode: 0, errorMessage: null, accounts: [] });
        response.writeHead(payload.status, { "Content-Type": "application/json" });
        response.end(payload.body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("server_address_unavailable");
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("single-flights concurrent authentication under token expiry", async () => {
    loginCalls = 0;
    validateCalls = 0;
    const manager = new ProjectXAuthManager({
      apiUrl: baseUrl,
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
    });

    await Promise.all(Array.from({ length: 100 }, () => manager.ensureAuthenticated()));

    assert.equal(loginCalls, 1, "expected exactly one login under concurrent refresh");
    assert.ok(validateCalls >= 1);
    assert.equal(manager.status().degraded, false);
  });

  it("recovers from one 401 on a safe read without duplicate login storms", async () => {
    loginCalls = 0;
    validateCalls = 0;
    const manager = new ProjectXAuthManager({
      apiUrl: baseUrl,
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
    });
    await manager.ensureAuthenticated();
    manager.forceExpiredForTests();
    await manager.searchAccounts(true);
    assert.equal(loginCalls, 2, "one relogin after forced expiry");
    assert.ok(validateCalls >= 1);
  });

  it("authenticatedClient ensures auth before REST calls", async () => {
    loginCalls = 0;
    const manager = new ProjectXAuthManager({
      apiUrl: baseUrl,
      username: "user",
      apiKey: "key",
      requestTimeoutMs: 5_000,
    });
    await manager.authenticatedClient().searchAccounts(true);
    assert.equal(loginCalls, 1);
  });
});

describe("TS-REAUDIT-01 ProjectXAuthManager bounded jittered backoff", () => {
  let server: Server;
  let baseUrl = "";
  let failuresRemaining = 0;
  let loginAttempts = 0;

  before(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "";
      if (path === "/api/Auth/loginKey") {
        loginAttempts += 1;
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ success: false, errorCode: 500, errorMessage: "boom" }));
          return;
        }
        const payload = jsonResponse({
          success: true,
          errorCode: 0,
          errorMessage: null,
          token: `session-${loginAttempts}`,
        });
        response.writeHead(payload.status, { "Content-Type": "application/json" });
        response.end(payload.body);
        return;
      }
      if (path === "/api/Auth/validate") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, errorCode: 0, errorMessage: null }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("server_address_unavailable");
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("waits a bounded, jittered delay before retrying after a failed login, and never resets the lifetime failure count on recovery", async () => {
    failuresRemaining = 2;
    loginAttempts = 0;
    let simulatedNowMs = 0;
    const sleeps: number[] = [];
    const manager = new ProjectXAuthManager(
      {
        apiUrl: baseUrl,
        username: "user",
        apiKey: "key",
        requestTimeoutMs: 5_000,
        // Single attempt per call, so a failure surfaces to the auth-manager level immediately
        // instead of being absorbed by the client's own transient-error retry (this test is
        // about the manager's cross-call backoff, not the client's within-call retry).
        rateLimitRetryMs: [0],
      },
      () => simulatedNowMs,
      async (ms) => {
        sleeps.push(ms);
        simulatedNowMs += ms;
      },
    );

    await assert.rejects(() => manager.ensureAuthenticated());
    assert.equal(sleeps.length, 0, "first attempt has no prior backoff to wait out");
    assert.equal(manager.status().refreshFailureCount, 1);

    await assert.rejects(() => manager.ensureAuthenticated());
    assert.equal(sleeps.length, 1, "second attempt waits out the backoff from the first failure");
    assert.ok(sleeps[0]! >= 1_000 && sleeps[0]! <= 1_250, `backoff ${sleeps[0]} out of bounds`);
    assert.equal(manager.status().refreshFailureCount, 2);

    const token = await manager.ensureAuthenticated();
    assert.ok(token.startsWith("session-"));
    assert.equal(manager.status().degraded, false);
    // Lifetime diagnostic count must survive recovery -- it feeds invariant_metrics.auth_refresh_failures.
    assert.equal(manager.status().refreshFailureCount, 2);
  });

  it("never spins into an unbounded retry loop -- backoff is capped", () => {
    const delays = [1, 2, 3, 4, 5, 20, 100].map((n) => projectXAuthBackoffDelayMs(n, () => 0));
    for (const delay of delays) {
      assert.ok(delay <= PROJECTX_AUTH_BACKOFF_MAX_MS * 1.25, `delay ${delay} exceeds the cap`);
    }
    // Growth is monotonic up to the cap, not runaway.
    assert.ok(delays[4]! >= delays[0]!);
    assert.equal(delays[5], delays[6], "delay stays flat at the cap once reached");
  });
});
