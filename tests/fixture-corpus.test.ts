import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  validateAuthEnvelopeFixture,
  validateFixtureManifest,
  validateHistoricalSearchFixtures,
  validateStreamEventCorpus,
  type FixtureManifest,
} from "../src/projectx/fixture-corpus.js";
import type { OrderInfo, TradeInfo } from "../src/domain/models.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "projectx", "live");

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as T;
}

describe("TS-R2-02 ProjectX fixture corpus", () => {
  it("manifest lists every required sanitized fixture", () => {
    const manifest = readFixture<FixtureManifest>("manifest");
    const failures = validateFixtureManifest(manifest);
    assert.deepEqual(failures, [], failures.join(", "));
  });

  it("stores official auth envelope shapes with secrets redacted", () => {
    const loginFailures = validateAuthEnvelopeFixture(
      readFixture("auth_login_key_envelope"),
      "auth_login_key_envelope",
    );
    const validateFailures = validateAuthEnvelopeFixture(
      readFixture("auth_validate_envelope"),
      "auth_validate_envelope",
    );
    assert.deepEqual([...loginFailures, ...validateFailures], []);
    const loginText = fs.readFileSync(path.join(FIXTURE_DIR, "auth_login_key_envelope.json"), "utf8");
    assert.match(loginText, /\[REDACTED\]/);
    assert.doesNotMatch(loginText, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
  });

  it("covers every required SignalR user and market event type in stream_event_samples", () => {
    const corpus = readFixture<{ samples: Array<{ event_type: string; source: string; raw_payload: unknown }> }>(
      "stream_event_samples",
    );
    const failures = validateStreamEventCorpus(corpus.samples);
    assert.deepEqual(failures, [], failures.join(", "));
  });
});

describe("TS-R2-06 ProjectX historical search identity", () => {
  it("retains glt custom tags on orders and orderId linkage on trades", () => {
    const orders = readFixture<OrderInfo[]>("historical_orders_24h");
    const trades = readFixture<TradeInfo[]>("historical_trades_24h");
    const failures = validateHistoricalSearchFixtures(orders, trades);
    assert.deepEqual(failures, [], failures.join(", "));
  });
});
