export const GATEWAY_COMPATIBILITY = Object.freeze({
  gateway_name: "glitch-topstep",
  gateway_version: "0.1.3",
  health_schema: "glitch.direct.health.v2",
  intent_schemas: Object.freeze(["glitch.intent.v2"]),
  decision_packet_schemas: Object.freeze([
    "glitch.direct.decision_packet.v1",
    "glitch.direct.decision_packet.v2",
  ]),
  capabilities: Object.freeze([
    "packet_supported_actions",
    "position_management",
    "tranche_ownership",
    "native_protection",
    "durable_mutation_receipts",
    "restart_reconciliation",
  ]),
});

export type GatewayCompatibility = typeof GATEWAY_COMPATIBILITY;
