import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFlatPosition, isTerminalOrderStatus } from "../src/domain/provider-entity-status.js";

describe("provider entity status (live and replay share this)", () => {
  it("treats ProjectX 2-5 as terminal and 0/1 as working", () => {
    assert.equal(isTerminalOrderStatus(1), false);
    assert.equal(isTerminalOrderStatus(2), true);
    assert.equal(isTerminalOrderStatus(5), true);
    assert.equal(isTerminalOrderStatus(6), false);
  });

  it("treats type 0 or size 0 as flat", () => {
    assert.equal(isFlatPosition({ type: 1, size: 1 }), false);
    assert.equal(isFlatPosition({ type: 0, size: 2 }), true);
    assert.equal(isFlatPosition({ type: 1, size: 0 }), true);
  });
});
