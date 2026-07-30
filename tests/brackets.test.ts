import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateBracketTicks, isTickAligned, toProjectXBracketTicks } from "../src/execution/brackets.js";

describe("ProjectX bracket translation", () => {
  it("converts absolute long geometry to conservative tick distances", () => {
    assert.deepEqual(calculateBracketTicks("long", 20_000.25, 19_990, 20_020, 0.25), {
      stopTicks: 41,
      targetTicks: 79,
    });
  });

  it("converts absolute short geometry", () => {
    assert.deepEqual(calculateBracketTicks("short", 20_000, 20_010, 19_980, 0.25), {
      stopTicks: 40,
      targetTicks: 80,
    });
  });

  it("rejects crossed geometry", () => {
    assert.throws(
      () => calculateBracketTicks("long", 100, 101, 110, 0.25),
      /stop_not_on_loss_side/,
    );
  });

  it("detects tick alignment", () => {
    assert.equal(isTickAligned(20_000.25, 0.25), true);
    assert.equal(isTickAligned(20_000.1, 0.25), false);
  });

  it("applies ProjectX signed bracket ticks by entry side", () => {
    const magnitudes = { stopTicks: 322, targetTicks: 475 };
    assert.deepEqual(toProjectXBracketTicks("long", magnitudes), {
      stopTicks: -322,
      targetTicks: 475,
    });
    assert.deepEqual(toProjectXBracketTicks("short", magnitudes), {
      stopTicks: 322,
      targetTicks: -475,
    });
  });
});
