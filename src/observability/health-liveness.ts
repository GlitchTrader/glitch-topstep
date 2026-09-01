import type { GatewayCompatibility } from "../release/compatibility.js";

/** Public liveness surface — no account, execution, or ProjectX operational detail (IA-260901-GW-04). */
export function buildHealthLiveness(compatibility: GatewayCompatibility): Record<string, unknown> {
  return {
    schema_version: "glitch.direct.health.v3",
    status: "ok",
    compatibility,
  };
}
