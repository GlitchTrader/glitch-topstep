import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it, after, before } from "node:test";
import { ProjectXAuthManager } from "../src/projectx/auth-manager.js";

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
