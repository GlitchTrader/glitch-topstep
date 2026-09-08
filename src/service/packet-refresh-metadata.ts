/** Apply bounded refresh metadata to packet data_quality without masking degradation. */

import type { MarketObservationState } from "../domain/market-observation.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";
import { observationAgeMs, PACKET_OBSERVATION_STALE_MS } from "../market/candidate-freshness.js";
import type { PacketObservationRefreshResult } from "./packet-observation-refresh.js";

export const PACKET_REFRESH_TIMEOUT_ISSUE = "market_observation_refresh_timeout";
export const PACKET_OBSERVATION_STALE_ISSUE = "market_observation_stale";

export function applyPacketObservationRefreshMetadata(
  packet: DirectDecisionPacket,
  refresh: PacketObservationRefreshResult | null,
  observation: MarketObservationState,
  staleMs: number = PACKET_OBSERVATION_STALE_MS,
  nowMs: number = Date.now(),
): void {
  if (refresh?.timed_out) {
    const optional = [...(packet.data_quality.optional_issues ?? [])];
    if (!optional.includes(PACKET_REFRESH_TIMEOUT_ISSUE)) {
      optional.push(PACKET_REFRESH_TIMEOUT_ISSUE);
    }
    packet.data_quality.optional_issues = optional;
  }
  const age = observationAgeMs(observation, nowMs);
  if (age === null || age >= staleMs) {
    const issues = [...packet.data_quality.issues];
    if (!issues.includes(PACKET_OBSERVATION_STALE_ISSUE)) {
      issues.push(PACKET_OBSERVATION_STALE_ISSUE);
    }
    packet.data_quality.issues = issues;
    packet.data_quality.state_complete = issues.length === 0;
  }
}
