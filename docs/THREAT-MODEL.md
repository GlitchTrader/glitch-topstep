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

Mitigation (implemented — see `docs/ROADMAP.md` R1, all checked):

- SQLite unique constraint on intent ID
- unique ProjectX custom tag
- atomic outbox persisted before the provider API call
- durable delivery receipt after API response and stream confirmation
- restart reconciliation against open/historical orders by custom tag
- append-only receipt

This section previously listed these as "required production mitigation" (not yet built); they have since shipped. Remaining open work in this area is process-kill fixture coverage at each of the four durability points above — see `docs/ROADMAP.md` R1's unchecked items, not a mitigation gap.

### Stale state

Mitigation:

- quote and account-state age limits
- stable decision snapshot hash
- no entry when state is incomplete
- explicit SignalR connection health and reconnect-generation tracking (`VenueStateStore`)
- REST reconciliation after reconnect
- generation ID preventing pre-reconnect intents from executing

Not available from the provider, not a code gap: ProjectX's SignalR payloads carry no sequence or offset field to detect a message gap (`docs/PROJECTX-API-REFERENCE.md` §7.6, confirmed against recorded evidence) — resubscribe-and-reconcile is the only recovery model the API supports.

Still open: formal PRAC proof of disconnect/reconnect/generation-invalidation/REST-reconciliation behavior against a real account (`docs/ROADMAP.md` R2, unchecked).

### Unprotected fills

Implemented: entry requests provider-side brackets (`stopLossBracket`/`takeProfitBracket`, tick distance) atomically with the entry order; ownership is proven via `customTag` convention (`<entry-tag>-SL`/`-TP`) against user-hub events, confirmed live 2026-07-30 (`docs/PARITY.md`).

Required before further acceptance (unchanged in substance, now precisely scoped by `docs/PROJECTX-API-REFERENCE.md`'s divergence findings D1–D3):

- map provider-created stop and target IDs from the provider's own `parentOrderId`/`linkedOrderId` relation, not just `customTag` convention (D1 — the fields arrive on the stream today and are discarded by the parser)
- recognize `status: 8` (suspended bracket child awaiting entry fill — undocumented by ProjectX, confirmed live) instead of treating it as ordinary "working" by exclusion (D2)
- close the REST reconciliation blind spot: `Order/searchOpen` never returns `status: 8`, so a bracket allocated between `place` and fill is invisible to REST recovery — masked today only because entries are market-only (D3)
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
