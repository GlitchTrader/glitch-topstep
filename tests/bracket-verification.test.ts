import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRACKET_VERIFICATION_TIMEOUT_MS,
  resolvePacketProtectionStatus,
} from "../src/execution/bracket-verification.js";
import { derivePacketProtection } from "../src/hermes/packet-builder.js";
import { snapshot } from "./fixtures.js";

describe("bracket verification", () => {
  it("maps proven internal status to confirmed protection_status", () => {
    const result = resolvePacketProtectionStatus({
      positionOpen: true,
      internalStatus: "proven",
      fillObservedUtc: "2026-08-05T12:00:00.000Z",
      stateComplete: true,
      nowUtc: "2026-08-05T12:00:05.000Z",
    });
    assert.equal(result.protection_status, "confirmed");
    assert.equal(result.timed_out, false);
    assert.equal(result.elapsed_ms, 5_000);
  });

  it("stays pending while awaiting venue brackets inside the timeout", () => {
    const result = resolvePacketProtectionStatus({
      positionOpen: true,
      internalStatus: "pending",
      fillObservedUtc: "2026-08-05T12:00:00.000Z",
      stateComplete: true,
      nowUtc: "2026-08-05T12:00:15.000Z",
      timeoutMs: BRACKET_VERIFICATION_TIMEOUT_MS,
    });
    assert.equal(result.protection_status, "pending");
    assert.equal(result.timed_out, false);
  });

  it("fails after the documented verification timeout", () => {
    const result = resolvePacketProtectionStatus({
      positionOpen: true,
      internalStatus: "pending",
      fillObservedUtc: "2026-08-05T12:00:00.000Z",
      stateComplete: true,
      nowUtc: "2026-08-05T12:00:31.000Z",
      timeoutMs: BRACKET_VERIFICATION_TIMEOUT_MS,
    });
    assert.equal(result.protection_status, "failed");
    assert.equal(result.reason, "bracket_verification_timeout");
    assert.equal(result.timed_out, true);
  });

  it("returns unknown when venue reconciliation is incomplete", () => {
    const result = resolvePacketProtectionStatus({
      positionOpen: true,
      internalStatus: "pending",
      fillObservedUtc: "2026-08-05T12:00:00.000Z",
      stateComplete: false,
      nowUtc: "2026-08-05T12:00:31.000Z",
    });
    assert.equal(result.protection_status, "unknown");
    assert.equal(result.reason, "reconciliation_incomplete");
  });

  it("exposes protection_status on the decision packet protection block", () => {
    const open = snapshot();
    open.instrumentOpenContracts = 1;
    open.totalOpenContracts = 1;
    const tags = "glt-00000000-0000-4000-8000-00000000a001";
    open.openOrders = [
      {
        id: 9101,
        accountId: open.account.id,
        contractId: open.contract.id,
        creationTimestamp: "2026-08-05T12:00:08Z",
        updateTimestamp: "2026-08-05T12:00:09Z",
        status: 1,
        type: 4,
        side: 1,
        size: 1,
        limitPrice: null,
        stopPrice: 19_990,
        customTag: `${tags}-SL`,
      },
      {
        id: 9102,
        accountId: open.account.id,
        contractId: open.contract.id,
        creationTimestamp: "2026-08-05T12:00:08Z",
        updateTimestamp: "2026-08-05T12:00:09Z",
        status: 1,
        type: 1,
        side: 1,
        size: 1,
        limitPrice: 20_020,
        stopPrice: null,
        customTag: `${tags}-TP`,
      },
    ];
    const protection = derivePacketProtection(open, null, [], {
      fillObservedUtc: "2026-08-05T12:00:10.000Z",
      stateComplete: true,
      nowUtc: "2026-08-05T12:00:12.000Z",
    });
    assert.equal(protection.status, "proven");
    assert.equal(protection.protection_status, "confirmed");
  });
});
