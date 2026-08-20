import assert from "node:assert/strict";
import test from "node:test";
import { isDataAlignmentPhaseDEnabled } from "../src/market/data-alignment-phase-d-gate.js";

test("TS-DATA-01 Phase D remains disabled unless explicit stable-session gate", () => {
  assert.equal(isDataAlignmentPhaseDEnabled("2026-08-20T00:00:00.000Z"), false);
});

test("TS-DATA-01 Phase D opens only after stable-after timestamp", () => {
  const previousPhaseD = process.env.GLITCH_DATA_PHASE_D;
  const previousStableAfter = process.env.GLITCH_DATA_PHASE_D_STABLE_AFTER_UTC;
  process.env.GLITCH_DATA_PHASE_D = "1";
  process.env.GLITCH_DATA_PHASE_D_STABLE_AFTER_UTC = "2026-08-21T00:00:00.000Z";
  try {
    assert.equal(isDataAlignmentPhaseDEnabled("2026-08-20T23:59:59.000Z"), false);
    assert.equal(isDataAlignmentPhaseDEnabled("2026-08-21T00:00:01.000Z"), true);
  } finally {
    if (previousPhaseD === undefined) {
      delete process.env.GLITCH_DATA_PHASE_D;
    } else {
      process.env.GLITCH_DATA_PHASE_D = previousPhaseD;
    }
    if (previousStableAfter === undefined) {
      delete process.env.GLITCH_DATA_PHASE_D_STABLE_AFTER_UTC;
    } else {
      process.env.GLITCH_DATA_PHASE_D_STABLE_AFTER_UTC = previousStableAfter;
    }
  }
});
