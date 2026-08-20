export const GATEWAY_COMPATIBILITY = Object.freeze({
  gateway_name: "glitch-topstep",
  gateway_version: "0.2.0",
  health_schema: "glitch.direct.health.v2",
  protocol_revision: "glitch.topstep.paired.v3",
  intent_schemas: Object.freeze(["glitch.intent.v2", "glitch.intent.v3"]),
  decision_packet_schemas: Object.freeze([
    "glitch.direct.decision_packet.v1",
    "glitch.direct.decision_packet.v2",
  ]),
  capabilities: Object.freeze([
    "packet_supported_actions",
    "position_management",
    "tranche_ownership",
    "native_protection",
    "bracket_verification",
    "durable_mutation_receipts",
    "restart_reconciliation",
    "intent_receipt_lookup",
    "bounded_entry_range_v1",
    "daily_capture_context_v1",
    "explicit_partial_completed_bars_v1",
    "revisioned_outcome_feed_v1",
    "multi_instrument_observation_v1",
    "protected_reduction_saga_v1",
    "immediate_lifecycle_facts_v1",
  ]),
  semantic_revisions: Object.freeze({
    bounded_entry_range: "glitch.topstep.entry_range.v1",
    daily_capture: "glitch.topstep.daily_capture.v1",
    outcome_feed: "glitch.topstep.outcome_feed.v2",
    market_universe: "glitch.topstep.market_universe.v1",
    execution_facts: "glitch.topstep.execution_fact.v1",
  }),
  provider_acceptance_evidence: Object.freeze({
    partial_exit_protection_transition: "proven_prac_short_long_with_saga",
    exact_contract_resolution: "catalog_fixture_plus_runtime_resolution",
  }),
  paired_manifest_schema: "glitch.topstep.paired_release.v1",
});

export type GatewayCompatibility = typeof GATEWAY_COMPATIBILITY;
