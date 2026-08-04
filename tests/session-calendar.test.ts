import assert from "node:assert/strict";
import test from "node:test";
import {
  emptySessionConfig,
  parseSessionLocalTime,
  resolveTopstepSession,
} from "../src/policy/session-calendar.js";

test("resolveTopstepSession publishes operator must_flat_utc ahead of now", () => {
  const session = resolveTopstepSession({
    ...emptySessionConfig(),
    mustFlatLocalTime: "15:10",
    timezone: "America/Chicago",
  }, new Date("2026-08-04T14:00:00.000Z"));

  assert.equal(session.authority, "operator_configured");
  assert.ok(session.must_flat_utc);
  assert.equal(session.entry_window_open, true);
  assert.ok(session.notes.some((note) => note.includes("operator-configured")));
});

test("resolveTopstepSession keeps must_flat unknown without operator schedule", () => {
  const session = resolveTopstepSession(emptySessionConfig(), new Date("2026-08-04T14:00:00.000Z"));
  assert.equal(session.must_flat_utc, null);
  assert.equal(session.entry_window_open, true);
  assert.ok(session.notes.some((note) => note.includes("unknown")));
});

test("parseSessionLocalTime rejects invalid clock values", () => {
  assert.throws(() => parseSessionLocalTime("25:00"), /invalid_session_local_time/);
});
