import assert from "node:assert/strict";
import test from "node:test";
import { emptyMarketObservationState, emptyOrderFlowState } from "../src/hermes/packet-builder.js";
import { buildStructuralLevels } from "../src/market/structural-levels.js";

test("buildStructuralLevels emits session levels with provenance when reliable", () => {
  const packet = buildStructuralLevels({
    generatedUtc: "2026-08-20T19:00:00.000Z",
    sessionHigh: 100,
    sessionLow: 90,
    sessionOpen: 95,
    sessionLevelsReliable: true,
    marketObservation: emptyMarketObservationState(),
    orderFlow: emptyOrderFlowState(),
  });
  assert.equal(packet.schema_version, "glitch.topstep.structural_levels.v1");
  assert.ok(packet.levels.some((row) => row.label === "session_high" && row.provenance.includes("session_high")));
  assert.ok(packet.levels.some((row) => row.label === "session_open"));
});

test("buildStructuralLevels omits session_open when session levels are unreliable", () => {
  const packet = buildStructuralLevels({
    generatedUtc: "2026-08-20T19:00:00.000Z",
    sessionHigh: null,
    sessionLow: null,
    sessionOpen: 29351.75,
    sessionLevelsReliable: false,
    marketObservation: emptyMarketObservationState(),
    orderFlow: emptyOrderFlowState(),
  });
  assert.ok(!packet.levels.some((row) => row.label === "session_open"));
  assert.ok(!packet.levels.some((row) => row.label === "session_high"));
});
