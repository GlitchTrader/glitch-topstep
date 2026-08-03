# TS-REL-01 — Gateway/profile compatibility metadata

**Issue:** #54  
**Gateway version:** 0.1.2

## Contract

Authenticated `/health` includes a nonsecret `compatibility` object naming the gateway package identity, health schema, accepted intent schema, emitted decision-packet schemas, and software capability families required by the Hermes profile.

Per-packet `execution.supported_actions` remains the current-state action authority. Global compatibility metadata never authorizes a trade or adds a market-strategy gate.

## Fields

- `gateway_name`
- `gateway_version`
- `health_schema`
- `intent_schemas`
- `decision_packet_schemas`
- `capabilities`

The contract contains no ProjectX credentials, local gateway token, account identifiers, policy values, or market evidence.

## Acceptance

- package and compatibility versions match in CI;
- health source includes the exact compatibility constant;
- schema and capability lists are stable and tested;
- paired profile setup/cycles fail closed when the contract is incompatible;
- packet-supported actions remain state-dependent.

## Evidence

The bounded transformation ran `npm ci`, `npm run build`, and the complete `npm test` suite before committing the gateway 0.1.2 product changes. GitHub Actions run `30775637719` completed every transformation, build, test, cleanup, commit, and push step successfully. Ordinary PR CI is rerun from this human-authored evidence commit before merge.
