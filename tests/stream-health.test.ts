import assert from "node:assert/strict";
import test from "node:test";
import {
  emptySessionConfig,
  resolveTopstepSession,
} from "../src/policy/session-calendar.js";
import { buildStreamHealthPacket } from "../src/policy/stream-health.js";
import { orderFlowWithTrades } from "./fixtures.js";

test("resolveTopstepSession publishes maintenance phase during CME halt window", () => {
  const session = resolveTopstepSession({
    ...emptySessionConfig(),
    phaseCalendarEnabled: true,
    maintenanceStartLocalTime: "16:00",
    maintenanceEndLocalTime: "17:00",
    timezone: "America/Chicago",
  }, new Date("2026-08-05T21:30:00.000Z"));

  assert.equal(session.phase, "maintenance");
  assert.equal(session.phase_authority, "exchange_calendar");
});

test("resolveTopstepSession publishes regular phase outside maintenance", () => {
  const session = resolveTopstepSession({
    ...emptySessionConfig(),
    phaseCalendarEnabled: true,
    maintenanceStartLocalTime: "16:00",
    maintenanceEndLocalTime: "17:00",
    timezone: "America/Chicago",
  }, new Date("2026-08-05T22:30:00.000Z"));

  assert.equal(session.phase, "regular");
  assert.equal(session.phase_authority, "exchange_calendar");
});

test("resolveTopstepSession keeps phase null when calendar disabled", () => {
  const session = resolveTopstepSession(emptySessionConfig(), new Date("2026-08-05T21:30:00.000Z"));
  assert.equal(session.phase, null);
  assert.equal(session.phase_authority, null);
});

test("buildStreamHealthPacket mirrors quote age, tape, and reconnect state", () => {
  const orderFlow = orderFlowWithTrades(12);
  const packet = buildStreamHealthPacket(
    {
      stateComplete: true,
      issues: [],
      quoteAgeMs: 9_500,
      stateAgeMs: 1_000,
    },
    orderFlow,
    "connected",
    "reconnecting",
    new Date("2026-07-21T12:00:10.000Z"),
  );

  assert.equal(packet.quote_age_ms, 9_500);
  assert.equal(packet.trade_count_60s, 12);
  assert.equal(packet.last_trade_age_ms, 10_000);
  assert.equal(packet.reconnect_pending, true);
  assert.ok(packet.notes.length > 0);
});
