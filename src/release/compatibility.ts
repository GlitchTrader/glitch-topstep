import packageJson from "../../package.json" with { type: "json" };
import pairedContract from "../../release/paired-contract.json" with { type: "json" };
import { DISTRIBUTED_STATE_MACHINE } from "./distributed-contract.js";

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
  distributed_contract: Object.freeze({
    schema_version: PAIRED_CONTRACT.distributed_contract.schema_version,
    amendment_source_schema: PAIRED_CONTRACT.distributed_contract.amendment_source_schema,
    original_risk_envelope_schema: PAIRED_CONTRACT.distributed_contract.original_risk_envelope_schema,
    model_owner_schema: PAIRED_CONTRACT.distributed_contract.model_owner_schema,
    outcome_path_chronology_schema:
      PAIRED_CONTRACT.distributed_contract.outcome_path_chronology_schema,
    cadence: Object.freeze({ ...PAIRED_CONTRACT.distributed_contract.cadence }),
    frozen_policies: Object.freeze({ ...DISTRIBUTED_STATE_MACHINE.frozen_policies }),
  }),
});

export type GatewayCompatibility = typeof GATEWAY_COMPATIBILITY;
