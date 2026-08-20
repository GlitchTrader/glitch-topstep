import packageJson from "../../package.json" with { type: "json" };
import pairedContract from "../../release/paired-contract.json" with { type: "json" };

export type PairedContract = typeof pairedContract;

/** Machine-readable paired contract — authority for protocol/profile drift (TS-AUDIT-10). */
export const PAIRED_CONTRACT = Object.freeze(pairedContract) as PairedContract;

export const GATEWAY_COMPATIBILITY = Object.freeze({
  gateway_name: PAIRED_CONTRACT.gateway.name,
  gateway_version: packageJson.version,
  health_schema: PAIRED_CONTRACT.health_schema,
  protocol_revision: PAIRED_CONTRACT.protocol_revision,
  runtime_intent_schema: PAIRED_CONTRACT.runtime_intent_schema,
  intent_schemas: Object.freeze([...PAIRED_CONTRACT.gateway_accepted_intent_schemas]),
  decision_packet_schemas: Object.freeze([...PAIRED_CONTRACT.decision_packet_schemas]),
  capabilities: Object.freeze([...PAIRED_CONTRACT.capabilities]),
  semantic_revisions: Object.freeze({ ...PAIRED_CONTRACT.semantic_revisions }),
  provider_acceptance_evidence: Object.freeze({ ...PAIRED_CONTRACT.provider_acceptance_evidence }),
  paired_manifest_schema: PAIRED_CONTRACT.paired_manifest_schema,
});

export type GatewayCompatibility = typeof GATEWAY_COMPATIBILITY;
