import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketObservationState } from "../src/domain/market-observation.js";
import type { DirectDecisionPacket } from "../src/hermes/packet-builder.js";
import { PACKET_OBSERVATION_STALE_MS } from "../src/market/candidate-freshness.js";
import { evaluateSnapshotDataQuality } from "../src/state/data-quality.js";
import {
  applyPacketObservationRefreshMetadata,
  PACKET_OBSERVATION_STALE_ISSUE,
  PACKET_REFRESH_TIMEOUT_ISSUE,
} from "../src/service/packet-refresh-metadata.js";
import { snapshot } from "./fixtures.js";

const NOW_MS = Date.parse("2026-09-08T16:41:45.000Z");
const FRESH_OBS_UTC = new Date(NOW_MS - 5_000).toISOString();
const STALE_OBS_UTC = new Date(NOW_MS - PACKET_OBSERVATION_STALE_MS - 1).toISOString();

const qualitySettings = {
  estimatedRoundTurnFeesUsd: 2.5,
  slippageReserveTicks: 2,
  maxQuoteAgeMs: 5_000,
  maxStateAgeMs: 15_000,
  maxIntentAgeMs: 300_000,
};

function observation(lastSucceededUtc: string | null): MarketObservationState {
  return {
    last_attempt_utc: lastSucceededUtc,
    last_succeeded_utc: lastSucceededUtc,
    last_error: null,
    observation: null,
  };
}

function packetFromVenue(stateComplete = true, issues: string[] = []) {
  return {
    data_quality: {
      state_complete: stateComplete,
      issues: [...issues],
      optional_issues: [] as string[],
      state_age_ms: 0,
      quote_age_ms: 0,
    },
  } as unknown as DirectDecisionPacket;
}

describe("applyPacketObservationRefreshMetadata", () => {
  it("cache within TTL with refresh timeout keeps explicit optional issue only", () => {
    const packet = packetFromVenue();
    applyPacketObservationRefreshMetadata(
      packet,
      { timed_out: true, skipped_fresh: false, waited_ms: 4_000 },
      observation(FRESH_OBS_UTC),
      PACKET_OBSERVATION_STALE_MS,
      NOW_MS,
    );
    assert.deepEqual(packet.data_quality.optional_issues, [PACKET_REFRESH_TIMEOUT_ISSUE]);
    assert.equal(packet.data_quality.state_complete, true);
    assert.equal(packet.data_quality.issues.length, 0);
  });

  it("cache outside TTL is rejected with market_observation_stale", () => {
    const packet = packetFromVenue();
    applyPacketObservationRefreshMetadata(
      packet,
      { timed_out: true, skipped_fresh: false, waited_ms: 4_000 },
      observation(STALE_OBS_UTC),
      PACKET_OBSERVATION_STALE_MS,
      NOW_MS,
    );
    assert.ok(packet.data_quality.issues.includes(PACKET_OBSERVATION_STALE_ISSUE));
    assert.equal(packet.data_quality.state_complete, false);
    assert.deepEqual(packet.data_quality.optional_issues, [PACKET_REFRESH_TIMEOUT_ISSUE]);
  });

  it("fresh skip leaves packet unchanged", () => {
    const packet = packetFromVenue();
    applyPacketObservationRefreshMetadata(
      packet,
      { timed_out: false, skipped_fresh: true, waited_ms: 0 },
      observation(FRESH_OBS_UTC),
      PACKET_OBSERVATION_STALE_MS,
      NOW_MS,
    );
    assert.equal(packet.data_quality.optional_issues?.length ?? 0, 0);
    assert.equal(packet.data_quality.state_complete, true);
  });

  it("quote_geometry_invalid remains blocking after refresh metadata", () => {
    const venue = snapshot();
    venue.quote = { ...venue.quote!, bestBid: 29500, bestAsk: 29419.5 };
    const quality = evaluateSnapshotDataQuality(venue, qualitySettings, new Date(NOW_MS));
    const packet = packetFromVenue(false, quality.issues);
    applyPacketObservationRefreshMetadata(
      packet,
      { timed_out: true, skipped_fresh: false, waited_ms: 4_000 },
      observation(FRESH_OBS_UTC),
      PACKET_OBSERVATION_STALE_MS,
      NOW_MS,
    );
    assert.ok(packet.data_quality.issues.includes("quote_geometry_invalid"));
    assert.equal(packet.data_quality.state_complete, false);
  });
});
