import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldWatchdogRestartGateway } from "../src/observability/gateway-watchdog-policy.js";

describe("gateway watchdog recovery policy", () => {
  it("restarts when health is unreachable", () => {
    assert.equal(shouldWatchdogRestartGateway(null), true);
  });

  it("does not restart when status is ok", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "ok",
        data_quality: { issues: ["quote_stale"] },
      }),
      false,
    );
  });

  it("restarts on degraded reconnecting streams with stale quotes", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: {
          issues: ["user_stream_reconnecting", "quote_stale"],
        },
      }),
      true,
    );
  });

  it("restarts on degraded reconciliation lag with stale quotes (streams may flap connected)", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: {
          issues: ["reconciliation_not_current", "quote_stale"],
        },
      }),
      true,
    );
  });

  it("does not restart degraded reconnecting without stale quotes", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["user_stream_reconnecting"] },
      }),
      false,
    );
  });

  it("does not restart degraded with only reconciliation_not_current (quiet market grace)", () => {
    assert.equal(
      shouldWatchdogRestartGateway({
        status: "degraded",
        data_quality: { issues: ["reconciliation_not_current"] },
      }),
      false,
    );
  });
});
