import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flattenControlCanComplete,
  flattenControlPhaseAfterReceipt,
} from "../src/control/flatten-control-saga.js";

describe("TS-AUDIT-07 flatten control saga", () => {
  it("does not complete flatten on submitted receipt while the venue is still open", () => {
    const phase = flattenControlPhaseAfterReceipt("submitted", {
      instrumentOpenContracts: 2,
      ownWorkingOrders: 1,
      stateComplete: true,
    });
    assert.equal(phase, "waiting_for_flat");
    assert.equal(flattenControlCanComplete(phase), false);
  });

  it("completes only after authoritative flat with no residual working orders", () => {
    const waiting = flattenControlPhaseAfterReceipt("submitted", {
      instrumentOpenContracts: 1,
      ownWorkingOrders: 0,
      stateComplete: true,
    });
    assert.equal(waiting, "waiting_for_flat");

    const done = flattenControlPhaseAfterReceipt("submitted", {
      instrumentOpenContracts: 0,
      ownWorkingOrders: 0,
      stateComplete: true,
    });
    assert.equal(done, "completed");
    assert.equal(flattenControlCanComplete(done), true);
  });

  it("keeps partial fills in waiting_for_flat instead of optimistic completion", () => {
    const phase = flattenControlPhaseAfterReceipt("accepted", {
      instrumentOpenContracts: 1,
      ownWorkingOrders: 0,
      stateComplete: true,
    });
    assert.equal(phase, "waiting_for_flat");
    assert.equal(flattenControlCanComplete(phase), false);
  });

  it("requires manual intervention when snapshot is incomplete even if flat", () => {
    const phase = flattenControlPhaseAfterReceipt("submitted", {
      instrumentOpenContracts: 0,
      ownWorkingOrders: 0,
      stateComplete: false,
    });
    assert.equal(phase, "waiting_for_flat");
    assert.equal(flattenControlCanComplete(phase), false);
  });
});
