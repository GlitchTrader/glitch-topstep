# Threat model

## Assets

- ProjectX API key and JWT
- account trading authority
- account and market state
- intent and order identity
- MLL and payout state
- event ledger and learning evidence

## Trust boundaries

```text
Hermes output                    untrusted proposal
Local HTTP caller                authenticated but not intrinsically trusted
ProjectX realtime payloads       authoritative venue input, schema-validated
Local configuration              operator-controlled authority
Risk engine                      deterministic enforcement boundary
ProjectX order API               irreversible external side effect
```

## Primary threats

### Model scope substitution

Mitigation:

- configured numeric account and contract are never model-controlled
- account name, instrument, and snapshot hash are checked
- unknown intent fields fail

### Duplicate execution

Current mitigation:

- in-process intent ID set
- unique ProjectX custom tag
- append-only receipt

Required production mitigation:

- SQLite unique constraint on intent ID
- restart reconciliation against open/historical orders by custom tag
- atomic outbox before API call
- durable delivery receipt after API response and stream confirmation

### Stale state

Mitigation:

- quote and account-state age limits
- stable decision snapshot hash
- no entry when state is incomplete

Required:

- explicit SignalR connection health
- sequence/gap detection where the provider exposes it
- REST reconciliation after reconnect
- generation ID preventing pre-reconnect intents from executing

### Unprotected fills

Current scaffold requests provider-side brackets with the entry.

Required before acceptance:

- confirm fill and child protection through user-hub events
- map provider-created stop and target IDs
- verify quantities
- correct bracket prices to exact absolute structural levels when needed
- flatten if protection cannot be proven within a bounded interval

### Local credential theft

Loopback and bearer authentication do not protect against a compromised Windows user.

Required:

- dedicated local OS identity
- OS credential store
- restrictive file ACLs
- no general-purpose browser or development workload under the runtime identity
- no API credentials in the Hermes profile

### Learning corruption

Hermes memory and cognitive overlays are interpretations, not venue truth.

Required:

- attributable completed episodes
- replay and shadow evaluation
- minimum comparable evidence
- canary activation
- predefined rollback
- no automatic change to risk, policy, credentials, account scope, or execution code
