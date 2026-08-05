import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import { emptySessionConfig } from "../src/policy/session-calendar.js";
import { snapshot } from "./fixtures.js";
import { orderFlowWithTrades } from "./fixtures.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";
import type { TopstepPolicyState } from "../src/domain/models.js";

const policy: TopstepPolicyState = {
  accountStage: "practice",
  lossModel: "trading_combine_eod",
  authority: "operator_configured",
  verifiedAtUtc: null,
  startingBalance: 50_000,
  initialMaximumLoss: 2_000,
  highestEndOfDayBalance: 0,
  lossFloorLockedAtZero: false,
  payoutProcessed: false,
  operatorProvidedLossFloorUsd: null,
  maxContracts: 1,
};

const recovery: ExecutionRecoveryStatus = {
  blockingAmbiguity: false,
  entrySubmissionPending: false,
  blockingNewExposure: false,
  unresolvedMutations: 0,
  ambiguousMutations: 0,
  lastRecoveryUtc: null,
  lastRecoveryError: null,
};

test("buildDecisionPacket exposes session authority and must_flat_utc", () => {
  const packet = buildDecisionPacket(
    snapshot(),
    policy,
    {
      estimatedRoundTurnFeesUsd: 2.5,
      slippageReserveTicks: 2,
      maxQuoteAgeMs: 5_000,
      maxStateAgeMs: 5_000,
      maxIntentAgeMs: 300_000,
    },
    recovery,
    "MNQ",
    "armed",
    300_000,
    new Date("2026-08-04T14:00:00.000Z"),
    undefined,
    orderFlowWithTrades(42),
    [],
    {
      ...emptySessionConfig(),
      mustFlatLocalTime: "15:10",
      timezone: "America/Chicago",
    },
  );

  assert.equal(packet.session.authority, "operator_configured");
  assert.ok(packet.session.must_flat_utc);
  assert.equal(typeof packet.session.entry_window_open, "boolean");
  assert.ok(Array.isArray(packet.session.notes));
  assert.equal(packet.session.phase, null);
  assert.ok(typeof packet.stream_health.quote_age_ms === "number");
  assert.equal(packet.stream_health.trade_count_60s, 42);
  assert.equal(packet.stream_health.reconnect_pending, false);
});
