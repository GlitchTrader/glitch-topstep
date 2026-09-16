import type { TradeIntent } from "../domain/models.js";
import type { DirectDecisionPacket } from "../hermes/packet-builder.js";

export function selectedCandidateHandoffMatchesPacket(
  intent: TradeIntent,
  packet: DirectDecisionPacket,
): boolean {
  const handoff = intent.selectedCandidateHandoff;
  if (intent.schemaVersion !== "glitch.intent.v4") return true;
  if (!handoff) return false;
  return intent.symbolId === packet.contract.symbol_id
    && handoff.selectedInstrument === packet.instrument
    && handoff.executableContractId === packet.contract.id
    && handoff.symbolId === packet.contract.symbol_id
    && handoff.packetId === packet.packet_id
    && handoff.snapshotHash === packet.market.snapshot_hash
    && handoff.scopeHash === packet.decision_scope.scope_hash
    && handoff.scopeGeneration === packet.decision_scope.generation
    && handoff.leaseGeneration === packet.decision_scope.generation
    && handoff.entryPriceMin === intent.entryPriceMin
    && handoff.entryPriceMax === intent.entryPriceMax
    && handoff.expiresUtc === intent.expiresUtc;
}
