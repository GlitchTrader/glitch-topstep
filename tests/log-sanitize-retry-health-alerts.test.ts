import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHealthAlerts } from "../src/observability/health-alerts.js";
import { sanitizeForLog } from "../src/observability/log-sanitize.js";
import { classifyProjectXError, isMutationPath, isTransportRetryableError, operationRetryDelayMs, parseRetryAfterMs, shouldRetryPost, shouldRetryRead } from "../src/projectx/retry-policy.js";
import { ProjectXApiError } from "../src/projectx/client.js";

describe("log sanitization", () => {
  it("redacts secret keys and bearer tokens", () => {
    const sanitized = sanitizeForLog({
      authorization: "Bearer abc.def.ghi",
      message: "Bearer secret-token in text",
      nested: { apiKey: "value" },
    }) as Record<string, unknown>;
    assert.equal(sanitized.authorization, "[redacted]");
    assert.equal((sanitized.nested as Record<string, unknown>).apiKey, "[redacted]");
    assert.match(String(sanitized.message), /\[redacted\]/);
  });
});

describe("retry policy", () => {
  it("classifies transient server errors as retryable reads", () => {
    assert.equal(
      classifyProjectXError(new ProjectXApiError("http_error", "boom", 503)),
      "read_idempotent",
    );
    assert.equal(
      classifyProjectXError(new ProjectXApiError("response_too_large", "big", 200)),
      "no_retry",
    );
  });

  it("does not retry mutation paths on HTTP 429", () => {
    const error = new ProjectXApiError("http_error", "rate limited", 429);
    assert.equal(isMutationPath("/api/Order/place"), true);
    assert.equal(shouldRetryPost("/api/Order/place", error, 0, 3), false);
    assert.equal(shouldRetryPost("/api/Account/search", error, 0, 3), true);
  });

  it("retries transport timeouts on idempotent reads", () => {
    const timeout = new Error("The operation was aborted");
    timeout.name = "TimeoutError";
    assert.equal(isTransportRetryableError(timeout), true);
    assert.equal(shouldRetryRead(timeout, 0, 3), true);
    assert.equal(shouldRetryRead(timeout, 2, 3), false);
  });

  it("parses Retry-After seconds and dates", () => {
    const headers = new Headers({ "Retry-After": "2" });
    assert.equal(parseRetryAfterMs(headers), 2_000);
    const future = new Date(Date.now() + 5_000).toUTCString();
    const dateHeaders = new Headers({ "Retry-After": future });
    const delay = parseRetryAfterMs(dateHeaders);
    assert.ok(delay !== null && delay >= 4_000 && delay <= 6_000);
    assert.equal(operationRetryDelayMs(0, 3_000), 3_000);
  });
});

describe("health alerts", () => {
  it("surfaces auth degradation and unprotected quantity", () => {
    const alerts = buildHealthAlerts({
      unprotected_open_quantity: 2,
      unprotected_seconds_estimate: 5,
      flatten_pending_seconds: null,
      auth_refresh_failures: 1,
      auth_degraded: true,
      auth_refresh_in_flight: false,
      reconciliation_age_ms: 1000,
      evidence_queue_depth: 0,
      evidence_queue_physical_depth: 0,
      evidence_queue_degraded: false,
      rest_snapshot_cache_size: 0,
      rest_snapshot_cache_max: 0,
      rest_snapshot_cache_evictions: 0,
      supervisor_gate_divergence: false,
      non_terminal_controls: 0,
      execution_recovery_blocking: false,
      orphan_protective_orders: 0,
    });
    assert.ok(alerts.some((alert) => alert.alert_id === "auth_degraded"));
    assert.ok(alerts.some((alert) => alert.alert_id === "unprotected_open_quantity"));
  });
});
