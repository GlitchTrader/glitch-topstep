import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  PROJECTX_MARKET_HUB_SUBSCRIPTIONS,
  PROJECTX_MARKET_STREAM_EVENT_TYPES,
  PROJECTX_STREAM_CONNECTED_LIFECYCLE_EVENTS,
  PROJECTX_USER_HUB_SUBSCRIPTIONS,
  PROJECTX_USER_STREAM_EVENT_TYPES,
  validateStreamSubscriptionProof,
  type StreamSubscriptionProof,
} from "../src/projectx/stream-subscriptions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "projectx", "live");

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as T;
}

describe("TS-R2-04 stream subscription proof", () => {
  it("documents the exact hub invoke list used by ProjectXRealtimeService", () => {
    assert.deepEqual(
      PROJECTX_USER_HUB_SUBSCRIPTIONS.map((item) => item.invoke),
      [
        "SubscribeAccounts",
        "SubscribeOrders",
        "SubscribePositions",
        "SubscribeTrades",
      ],
    );
    assert.deepEqual(
      PROJECTX_MARKET_HUB_SUBSCRIPTIONS.map((item) => item.invoke),
      [
        "SubscribeContractQuotes",
        "SubscribeContractTrades",
        "SubscribeContractMarketDepth",
      ],
    );
  });

  it("requires every user, market, and lifecycle event type in the live proof fixture", () => {
    const proof = readFixture<StreamSubscriptionProof>("stream_subscriptions_proof");
    const failures = validateStreamSubscriptionProof(proof);
    assert.deepEqual(
      failures,
      [],
      `stream_subscriptions_proof failures: ${failures.join(", ")}`,
    );
    assert.equal(proof.proof_passed, true);

    for (const eventType of PROJECTX_USER_STREAM_EVENT_TYPES) {
      assert.ok(
        proof.observed_event_types.projectx_user_stream?.includes(eventType),
        `missing user stream event ${eventType}`,
      );
    }
    for (const eventType of PROJECTX_MARKET_STREAM_EVENT_TYPES) {
      assert.ok(
        proof.observed_event_types.projectx_market_stream?.includes(eventType),
        `missing market stream event ${eventType}`,
      );
    }
    for (const eventType of PROJECTX_STREAM_CONNECTED_LIFECYCLE_EVENTS) {
      assert.ok(
        proof.observed_event_types.projectx_lifecycle?.includes(eventType),
        `missing lifecycle event ${eventType}`,
      );
    }
  });

  it("maps HANDOFF connection-health fields through the live gateway health fixture", () => {
    const proof = readFixture<StreamSubscriptionProof>("stream_subscriptions_proof");
    const health = readFixture<{ health: { data_quality: { operational: unknown } } }>("gateway_health");

    const operational = health.health.data_quality.operational as {
      generation: number;
      userStream: { state: string; lastEventAt: string | null };
      marketStream: { state: string; lastEventAt: string | null };
      reconciliation: { state: string; generation: number };
    };

    assert.equal(proof.connection_health.user_stream_state, operational.userStream.state);
    assert.equal(proof.connection_health.market_stream_state, operational.marketStream.state);
    assert.equal(proof.connection_health.last_user_event_utc, operational.userStream.lastEventAt);
    assert.equal(proof.connection_health.last_market_event_utc, operational.marketStream.lastEventAt);
    assert.equal(proof.connection_health.reconciliation_generation, operational.reconciliation.generation);
    assert.equal(proof.connection_health.operational_generation, operational.generation);
  });
});
