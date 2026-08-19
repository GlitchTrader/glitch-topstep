import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionPacket } from "../src/hermes/packet-builder.js";
import {
  computeDailyEconomics,
  type DailyEconomicsConfig,
} from "../src/policy/daily-economics.js";
import {
  emptySessionConfig,
  resolveTradingDayId,
  tradingDayBoundsUtc,
} from "../src/policy/session-calendar.js";
import type { TradeOutcomeV1 } from "../src/learning/trade-outcome.js";
import type { TopstepPolicyState } from "../src/domain/models.js";
import { snapshot } from "./fixtures.js";
import type { ExecutionRecoveryStatus } from "../src/domain/execution-state.js";

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

const risk = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 5_000,
  maxIntentAgeMs: 300_000,
};

const session = {
  ...emptySessionConfig(),
  timezone: "America/Chicago",
  tradingDayResetLocalTime: "17:00",
};

function outcome(exitUtc: string, realized: number): TradeOutcomeV1 {
  return {
    schema_version: "glitch.topstep.trade_outcome.v1",
    outcome_id: `outcome:${exitUtc}`,
    intent_id: `intent:${exitUtc}`,
    account: "TEST_ACCOUNT",
    instrument: "MNQ",
    entry_utc: "2026-08-05T14:00:00.000Z",
    exit_utc: exitUtc,
    realized_pnl_usd: realized,
    fees_usd: 0,
    learning_eligible: true,
  };
}

test("resolveTradingDayId rolls at the configured maintenance boundary", () => {
  assert.equal(
    resolveTradingDayId(new Date("2026-08-05T20:00:00.000Z"), "America/Chicago", "17:00"),
    "2026-08-05",
  );
  assert.equal(
    resolveTradingDayId(new Date("2026-08-05T23:30:00.000Z"), "America/Chicago", "17:00"),
    "2026-08-06",
  );
});

test("tradingDayBoundsUtc spans maintenance-to-maintenance window", () => {
  const bounds = tradingDayBoundsUtc("2026-08-05", "America/Chicago", "17:00");
  assert.equal(bounds.startUtc, "2026-08-04T22:00:00.000Z");
  assert.equal(bounds.endExclusiveUtc, "2026-08-05T22:00:00.000Z");
});

test("computeDailyEconomics sums realized outcomes inside the trading day", () => {
  const config: DailyEconomicsConfig = {
    enabled: true,
    nominalSizeUsd: 50_000,
    profitTargetUsd: 3_000,
  };
  const now = new Date("2026-08-05T18:00:00.000Z");
  const economics = computeDailyEconomics(
    config,
    session,
    policy,
    85,
    50_505,
    [
      outcome("2026-08-05T15:00:00.000Z", 300),
      outcome("2026-08-05T21:30:00.000Z", 120),
      outcome("2026-08-04T21:00:00.000Z", 999),
    ],
    true,
    now,
  );

  assert.ok(economics);
  assert.equal(economics?.trading_day_id, "2026-08-05");
  assert.equal(economics?.realized_pnl_usd, 420);
  assert.equal(economics?.unrealized_pnl_usd, 85);
  assert.equal(economics?.net_daily_pnl_usd, 505);
  assert.equal(economics?.net_daily_pnl_pct, 1.01);
  assert.equal(economics?.profit_target_remaining_usd, 2_495);
  assert.equal(economics?.authority, "reconciled_trades");
  assert.deepEqual(economics?.calibration_band_pct, { low: 0.4, high: 2.0 });
  assert.equal(economics?.daily_capture.objective_rate_pct, 0.5);
  assert.equal(economics?.daily_capture.objective_usd, 250);
  assert.equal(economics?.daily_capture.realized_progress_usd, 420);
  assert.equal(economics?.daily_capture.reached, true);
  assert.equal(economics?.daily_capture.remaining_usd, 0);
});

test("computeDailyEconomics returns null when disabled", () => {
  const economics = computeDailyEconomics(
    { enabled: false, nominalSizeUsd: null, profitTargetUsd: null },
    session,
    policy,
    0,
    50_000,
    [],
    true,
  );
  assert.equal(economics, null);
});

test("buildDecisionPacket includes daily_economics when supplied", () => {
  const economics = computeDailyEconomics(
    { enabled: true, nominalSizeUsd: 50_000, profitTargetUsd: null },
    session,
    policy,
    0,
    50_000,
    [],
    true,
    new Date("2026-08-05T18:00:00.000Z"),
  );
  const packet = buildDecisionPacket(
    snapshot(),
    policy,
    risk,
    recovery,
    "MNQ",
    "armed",
    300_000,
    new Date("2026-08-05T18:00:00.000Z"),
    undefined,
    undefined,
    [],
    session,
    economics,
  );

  assert.ok(packet.daily_economics);
  assert.equal(packet.daily_economics?.nominal_size_usd, 50_000);
  assert.ok(packet.daily_economics?.notes.some((note) => note.includes("not Topstep dashboard authority")));
});
