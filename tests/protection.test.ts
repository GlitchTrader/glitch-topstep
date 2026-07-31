import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindProtection,
  protectionCustomTags,
  resolveProtectiveLeg,
} from "../src/ownership/protection.js";
import type { OrderInfo } from "../src/domain/models.js";

const ACCOUNT_ID = 101;
const CONTRACT_ID = "CON.F.US.MNQ.U26";
const INTENT_ID = "00000000-0000-4000-8000-00000000a001";

function order(
  id: number,
  customTag: string,
  type: number,
  price: number | null,
): OrderInfo {
  return {
    id,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    creationTimestamp: "2026-07-21T12:00:08Z",
    updateTimestamp: "2026-07-21T12:00:09Z",
    status: 1,
    type,
    side: 1,
    size: 1,
    limitPrice: type === 1 ? price : null,
    stopPrice: type === 4 ? price : null,
    customTag,
  };
}

describe("protection ownership", () => {
  it("derives SL and TP custom tags from the entry intent id", () => {
    const tags = protectionCustomTags(INTENT_ID);
    assert.equal(tags.entry, `glt-${INTENT_ID}`);
    assert.equal(tags.stop, `glt-${INTENT_ID}-SL`);
    assert.equal(tags.target, `glt-${INTENT_ID}-TP`);
  });

  it("binds protective legs only by exact custom tag", () => {
    const tags = protectionCustomTags(INTENT_ID);
    const stop = order(9101, tags.stop, 4, 19_990);
    const target = order(9102, tags.target, 1, 20_020);
    const nearby = order(9103, "glt-other", 4, 19_990);
    const protection = bindProtection(
      INTENT_ID,
      [stop, target, nearby],
      ACCOUNT_ID,
      CONTRACT_ID,
      true,
    );
    assert.equal(protection.status, "proven");
    assert.equal(protection.stop.providerOrderId, 9101);
    assert.equal(protection.target.providerOrderId, 9102);
    assert.equal(protection.stop.price, 19_990);
    assert.equal(protection.target.price, 20_020);
  });

  it("binds venue brackets that carry no tag through parentOrderId", () => {
    const untaggedStop: OrderInfo = { ...order(9201, "", 4, 19_990), customTag: null, parentOrderId: 9001 };
    const untaggedTarget: OrderInfo = { ...order(9202, "", 1, 20_020), customTag: null, parentOrderId: 9001 };
    const otherEntryChild: OrderInfo = { ...order(9203, "", 4, 19_900), customTag: null, parentOrderId: 9002 };
    const protection = bindProtection(
      INTENT_ID,
      [untaggedStop, untaggedTarget, otherEntryChild],
      ACCOUNT_ID,
      CONTRACT_ID,
      true,
      9001,
    );
    assert.equal(protection.status, "proven");
    assert.equal(protection.stop.providerOrderId, 9201);
    assert.equal(protection.target.providerOrderId, 9202);
  });

  it("reports pending when a position is open but a child leg is missing", () => {
    const tags = protectionCustomTags(INTENT_ID);
    const stop = resolveProtectiveLeg(
      tags.stop,
      4,
      [order(9101, tags.stop, 4, 19_990)],
      ACCOUNT_ID,
      CONTRACT_ID,
    );
    const protection = bindProtection(
      INTENT_ID,
      stop.observedOrder ? [stop.observedOrder] : [],
      ACCOUNT_ID,
      CONTRACT_ID,
      true,
    );
    assert.equal(protection.status, "pending");
    assert.match(protection.reason, /target_child_not_observed/);
  });
});
