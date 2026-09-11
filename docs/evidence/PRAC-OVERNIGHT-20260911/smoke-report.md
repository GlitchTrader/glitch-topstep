# PRAC overnight smoke — 2026-09-11

## Result

`smoke_pass`

- Gateway SHA: `4943b3265bb83836867a6ff0f0d61296d3567e61`
- Profile SHA: `81af2b8b1e367c01d9380b85824a0cf116b9cba2`
- Hermes invocation: official absolute executable, `chat -Q -q`
- Envelope: `env-27ae2b144bdff9e0`
- Envelope hash: `63d3ee137ef0d214c3e25a9dc865799a8d2d5da3733a1894d7c31854cb7c67f9`
- Profiles invoked: 6/6
- Decision: `no_selection` / `INSUFFICIENT_ENSEMBLE_AGREEMENT`
- Delivery: not delivered; no intent required
- Orders: `0`
- Reconciliation after smoke: succeeded; account flat; working orders `0`
- Unresolved or ambiguous mutations: `0/0`

All six profile responses were parsed and normalized. Evidence states, including `no_edge` and `missing_required_evidence`, were preserved. The global decision was valid and fail-closed; no execution fields were required for `global_nothing`.

The overnight soak was authorized to begin automatically after this result and is recorded separately.
