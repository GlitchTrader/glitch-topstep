import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
  DEFAULT_LIVENESS_CHECK_INTERVAL_MS,
  DEFAULT_STREAM_LIVENESS_MS,
  DEFAULT_STUCK_STREAM_MS,
  hubLivenessWorstCaseMs,
  isHubMarketEventStale,
  livenessCheckIntervalMs,
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

  it("documents hub liveness worst-case delay before restartHub", () => {
    assert.equal(livenessCheckIntervalMs(DEFAULT_STREAM_LIVENESS_MS), 5_000);
    assert.equal(
      hubLivenessWorstCaseMs(DEFAULT_STREAM_LIVENESS_MS),
      DEFAULT_STREAM_LIVENESS_MS + (DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES - 1) * DEFAULT_LIVENESS_CHECK_INTERVAL_MS,
    );
    assert.equal(hubLivenessWorstCaseMs(DEFAULT_STREAM_LIVENESS_MS), 25_000);
  });

  it("forces market restart when connected but silent past the liveness window and debounce", () => {
    const nowMs = Date.parse("2026-08-13T21:23:00.000Z");
    assert.equal(
      isHubMarketEventStale({
        lastHubEventAt: "2026-08-13T21:12:57.000Z",
        connectedSinceUtc: "2026-08-13T21:12:47.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
      }),
      true,
    );
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "connected",
        lastHubEventAt: "2026-08-13T21:12:57.000Z",
        connectedSinceUtc: "2026-08-13T21:12:47.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
      }),
      true,
    );
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "connected",
        lastHubEventAt: "2026-08-13T21:12:57.000Z",
        connectedSinceUtc: "2026-08-13T21:12:47.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES - 1,
      }),
      false,
    );
  });

  it("does not force restart during maintenance, while hub events are fresh, or on first stale check", () => {
    const nowMs = Date.parse("2026-08-13T21:13:00.000Z");
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: false,
        streamState: "connected",
        lastHubEventAt: "2026-08-13T21:12:00.000Z",
        connectedSinceUtc: "2026-08-13T21:12:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
      }),
      false,
    );
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "connected",
        lastHubEventAt: "2026-08-13T21:12:55.000Z",
        connectedSinceUtc: "2026-08-13T21:12:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
      }),
      false,
    );
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "disconnected",
        lastHubEventAt: "2026-08-13T21:00:00.000Z",
        connectedSinceUtc: "2026-08-13T21:00:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
      }),
      false,
    );
  });

  it("treats depth or trade freshness as hub alive even when quote-only anchor would be stale", () => {
    const nowMs = Date.parse("2026-08-13T21:13:00.000Z");
    const staleQuoteAt = "2026-08-13T21:12:00.000Z";
    const freshDepthAt = "2026-08-13T21:12:58.000Z";
    assert.equal(
      isHubMarketEventStale({
        lastHubEventAt: staleQuoteAt,
        connectedSinceUtc: staleQuoteAt,
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
      }),
      true,
    );
    assert.equal(
      isHubMarketEventStale({
        lastHubEventAt: freshDepthAt,
        connectedSinceUtc: staleQuoteAt,
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
        lastHubEventAt: freshDepthAt,
        connectedSinceUtc: staleQuoteAt,
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
      }),
      false,
    );
  });

  it("does not force restart while market stream is reconnecting (stuck timer covers limbo)", () => {
    const nowMs = Date.parse("2026-08-13T21:23:00.000Z");
    assert.equal(
      shouldForceMarketLivenessRestart({
        stopped: false,
        expectedLive: true,
        streamState: "reconnecting",
        lastHubEventAt: "2026-08-13T21:00:00.000Z",
        connectedSinceUtc: "2026-08-13T21:00:00.000Z",
        nowMs,
        livenessMs: DEFAULT_STREAM_LIVENESS_MS,
        consecutiveStaleChecks: DEFAULT_HUB_LIVENESS_DEBOUNCE_FAILURES,
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
