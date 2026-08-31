import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectXApiError } from "../src/projectx/client.js";
import { ReadCircuitBreaker, readEndpointFamily } from "../src/projectx/read-circuit-breaker.js";

describe("readEndpointFamily", () => {
  it("groups the tightly-rate-limited bars endpoint on its own", () => {
    assert.equal(readEndpointFamily("/api/History/retrieveBars"), "bars");
  });

  it("separates positions, orders, and accounts", () => {
    assert.equal(readEndpointFamily("/api/Position/searchOpen"), "positions");
    assert.equal(readEndpointFamily("/api/Order/searchOpen"), "orders");
    assert.equal(readEndpointFamily("/api/Order/search"), "orders");
    assert.equal(readEndpointFamily("/api/Account/search"), "accounts");
  });
});

describe("ReadCircuitBreaker (TS-AUDIT31-PX-01: isolated per endpoint family)", () => {
  it("a failure burst on retrieveBars does not open the breaker for positions or orders", () => {
    const breaker = new ReadCircuitBreaker(3, 30_000);
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("/api/History/retrieveBars");
    }
    assert.throws(
      () => breaker.assertAllows("/api/History/retrieveBars"),
      ProjectXApiError,
    );
    // Reconciliation-critical reads on other families must stay unaffected.
    assert.doesNotThrow(() => breaker.assertAllows("/api/Position/searchOpen"));
    assert.doesNotThrow(() => breaker.assertAllows("/api/Order/searchOpen"));
    assert.doesNotThrow(() => breaker.assertAllows("/api/Account/search"));
  });

  it("a failure burst on searchOpenOrders does not impede bars reads", () => {
    const breaker = new ReadCircuitBreaker(3, 30_000);
    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure("/api/Order/searchOpen");
    }
    assert.throws(
      () => breaker.assertAllows("/api/Order/searchOpen"),
      ProjectXApiError,
    );
    assert.doesNotThrow(() => breaker.assertAllows("/api/History/retrieveBars"));
  });

  it("still opens for the same family once its own threshold is reached", () => {
    const breaker = new ReadCircuitBreaker(2, 30_000);
    breaker.recordFailure("/api/Trade/search");
    assert.doesNotThrow(() => breaker.assertAllows("/api/Trade/search"));
    breaker.recordFailure("/api/Trade/search");
    assert.throws(() => breaker.assertAllows("/api/Trade/search"), ProjectXApiError);
  });

  it("a success clears only its own family's failure count", () => {
    const breaker = new ReadCircuitBreaker(3, 30_000);
    breaker.recordFailure("/api/Order/search");
    breaker.recordFailure("/api/History/retrieveBars");
    breaker.recordSuccess("/api/Order/search");
    breaker.recordFailure("/api/Order/search");
    // Order/search should need 2 more failures after the reset (started fresh from success).
    assert.doesNotThrow(() => breaker.assertAllows("/api/Order/search"));
    assert.doesNotThrow(() => breaker.assertAllows("/api/History/retrieveBars"));
  });

  it("mutations are never gated by any family", () => {
    const breaker = new ReadCircuitBreaker(1, 30_000);
    breaker.recordFailure("/api/Order/place");
    breaker.recordFailure("/api/Order/place");
    assert.doesNotThrow(() => breaker.assertAllows("/api/Order/place"));
  });

  it("cooldown state is observable per family", () => {
    const breaker = new ReadCircuitBreaker(1, 30_000);
    breaker.recordFailure("/api/History/retrieveBars");
    const status = breaker.status();
    assert.equal(status.bars?.open, true);
    assert.equal(status.orders, undefined);
  });
});
