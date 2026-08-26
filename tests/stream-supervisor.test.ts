import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_STREAM_LIVENESS_MS,
  DEFAULT_STUCK_STREAM_MS,
  nextSignalRReconnectDelayMs,
  shouldForceMarketLivenessRestart,
  shouldForceStuckStreamRestart,
  shouldScheduleHubRestart,
} from "../src/projectx/stream-supervisor.js";

describe("SignalR stream supervisor", () => {
  it("never returns null — reconnect delay stays capped, not exhausted", () => {
    assert.equal(nextSignalRReconnectDelayMs(0), 0);
    assert.equal(nextSignalRReconnectDelayMs(1), 2_000);
    assert.equal(nextSignalRReconnectDelayMs(2), 10_000);
    assert.equal(nextSignalRReconnectDelayMs(3), 30_000);
    assert.equal(nextSignalRReconnectDelayMs(4), 60_000);
    assert.equal(nextSignalRReconnectDelayMs(40), 60_000);
  });

  it("schedules hub restart only when the process still wants the stream", () => {
    assert.equal(shouldScheduleHubRestart({ stopped: false, restartInFlight: false }), true);
    assert.equal(shouldScheduleHubRestart({ stopped: true, restartInFlight: false }), false);
    assert.equal(shouldScheduleHubRestart({ stopped: false, restartInFlight: true }), false);
  });

  it("forces market restart when connected but silent past the liveness window", () => {
    const nowMs = Date.parse("2026-08-13T21:23:00.000Z");
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "connected",
        lastEventAt: "2026-08-13T21:12:57.000Z",
        connectedSinceUtc: "2026-08-13T21:12:47.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
      }),
      true,
    );
  });

  it("does not force restart during maintenance or while events are fresh", () => {
    const nowMs = Date.parse("2026-08-13T21:13:00.000Z");
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: false,
        streamState: "connected",
        lastEventAt: "2026-08-13T21:12:00.000Z",
        connectedSinceUtc: "2026-08-13T21:12:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
      }),
      false,
    );
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "connected",
        lastEventAt: "2026-08-13T21:12:55.000Z",
        connectedSinceUtc: "2026-08-13T21:12:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
      }),
      false,
    );
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "disconnected",
        lastEventAt: "2026-08-13T21:00:00.000Z",
        connectedSinceUtc: "2026-08-13T21:00:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
      }),
      false,
    );
  });

  it("forces stuck connecting/disconnected/reconnecting restart after the stuck window", () => {
    const nowMs = Date.parse("2026-08-24T15:10:00.000Z");
    assert.equal(
      shouldForceStuckStreamRestart({
        stopped: false,
        streamState: "connecting",
        lastChangedAt: "2026-08-24T15:08:00.000Z",
        nowMs,
        stuckMs: DEFAULT_STUCK_STREAM_MS,
      }),
      true,
    );
    assert.equal(
      shouldForceStuckStreamRestart({
        stopped: false,
        streamState: "disconnected",
        lastChangedAt: "2026-08-24T15:08:30.000Z",
        nowMs,
        stuckMs: DEFAULT_STUCK_STREAM_MS,
      }),
      true,
    );
    assert.equal(
      shouldForceStuckStreamRestart({
        stopped: false,
        streamState: "reconnecting",
        lastChangedAt: "2026-08-24T15:08:30.000Z",
        nowMs,
        stuckMs: DEFAULT_STUCK_STREAM_MS,
      }),
      true,
    );
    assert.equal(
      shouldForceStuckStreamRestart({
        stopped: false,
        streamState: "connecting",
        lastChangedAt: "2026-08-24T15:09:30.000Z",
        nowMs,
        stuckMs: DEFAULT_STUCK_STREAM_MS,
      }),
      false,
    );
    assert.equal(
      shouldForceStuckStreamRestart({
        stopped: false,
        streamState: "connected",
        lastChangedAt: "2026-08-24T15:00:00.000Z",
        nowMs,
        stuckMs: DEFAULT_STUCK_STREAM_MS,
      }),
      false,
    );
  });
});
