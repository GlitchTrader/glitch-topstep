# Operations

## Deployment rule

Run on the trader's personal local device. Do not deploy this Topstep adapter to a VPS, VPN, remote server, or centralized cloud executor.

A commercial product should install a customer-side gateway and keep credentials local.

## One-account beta pair (TS-BETA-01)

Immutable candidate baseline: [`docs/evidence/TS-BETA-01-immutable-baseline-2026-08-04.md`](evidence/TS-BETA-01-immutable-baseline-2026-08-04.md).

Pin: gateway **0.1.4** (`abf7a02`) + Hermes profile **0.1.17** (`efb8c22`) on PRAC `47191819` / MNQ. Promoted 2026-08-05 via operator shortcut acceptance in the baseline doc.

## Initial configuration

1. Link TopstepX to ProjectX.
2. Purchase ProjectX API Access.
3. Generate an API key in TopstepX settings.
4. Copy `.env.example` to `.env`.
5. Set exact account and active contract identifiers.
6. Keep `GLITCH_TRADING_MODE=shadow`.
7. Keep `GLITCH_ENTRY_WINDOW_OPEN=false` until a session-policy service is implemented.
8. Run `npm run check` and `npm start`.

## Epoch / account reset checklist

Do this **every** time you reset epoch state or switch to a new Topstep/PRAC account. New accounts often default to Position Brackets; protected API entries then fail with `Brackets cannot be used with Position Brackets`.

1. **Enable Auto OCO Brackets** on the account in TopstepX (disable Position Brackets if both appear).
2. Confirm account ID / name / contract / loss-floor fields in gateway `.env`.
3. Leave `GLITCH_TOPSTEP_OUTCOMES_EXPORT_PATH` unset (see [Outcome feed ownership](#outcome-feed-ownership)).
4. Restart gateway; prove `/health` is `armed` or `shadow` as intended and `state_complete=true`.
5. Run one protected round-trip (ENTER → fill → flat) before trusting learning/outcomes.

## Shadow acceptance

Before any armed test, prove:

- the configured account ID and name resolve uniquely
- the configured contract is active
- REST positions and orders match the TopstepX UI
- SignalR quote, order, position, and trade events arrive
- reconnect resubscription works
- no event gap is silently accepted
- `/packet` remains stable until authoritative state changes
- malformed and wrong-account intents fail
- valid entries are journaled as shadowed
- stop-aware risk matches an independent spreadsheet
- MLL floor matches the Topstep dashboard

## Outcome feed ownership

The gateway SQLite revision feed (`trade-outcomes.sqlite`) is the **sole canonical writer** of trade outcomes. Hermes must consume `GET /outcomes/feed?after_sequence=<cursor>&limit=<n>` (`glitch.topstep.outcome_feed.v2`) and keep its own cursor; it must not read or write the gateway JSONL.

`GLITCH_TOPSTEP_OUTCOMES_EXPORT_PATH` is **deprecated and emergency-only**. It mirrors outcomes into the Hermes profile `state/outcomes.jsonl`, which creates a second mutable writer for the same records. Set it only to bridge a Hermes outage that blocks the HTTP feed, and unset it as soon as the feed is reachable again.

## Immediate lifecycle facts (TS-EXEC-01)

`GET /execution/facts?after_sequence=<cursor>&limit=<n>` publishes attributable lifecycle facts per `intent_id` — admission, submission, provider acceptance/rejection, fill (partial, full, exit), protection confirmation or failure, amendment and flat — without waiting for the enriched outcome. Each fact carries a stable `fact_id`, a `revision` that increments when the same moment is corrected, and a `diagnostics` block that separates `rejection_code`, fill presence, protection fidelity (`proven`/`pending`/`failed`) and latency fields (null when unmeasured).

Facts stay in the feed with `status: "live"` until the revisioned outcome for the same intent lands; publication then flips them to `superseded_by_outcome` and appends an `outcome_superseded` fact naming the `outcome_id`. Superseded rows are retained for audit, and `GET /health` reports live/superseded counts under `execution_facts`.

## Armed partial EXIT (ProtectedReductionSaga)

Armed `EXIT` that reduces an open position without flattening it is admitted by default through a durable `ProtectedReductionSaga` (SQLite `protected_reductions`). Compatibility advertises `protected_reduction_saga_v1` and `partial_exit_protection_transition: proven_prac_short_long_with_saga` after SHORT + LONG PRAC fixtures.

**Invariant:** while venue open quantity is positive, stop coverage on the provider must be ≥ that quantity, except during explicit `degraded_stop_only` (stop present, TP missing). The saga never cancels the last proven survivor stop before the reduction is on the wire; rearm places stop before target.

**Health:** `GET /health` → `protected_reduction` exposes `active_state`, `unprotected_open_quantity`, `orphan_protective_orders`, `ambiguous_age_ms`, `fail_closed_rollback`.

**Emergency rollback (no redeploy):** set `GLITCH_PARTIAL_EXIT_FAIL_CLOSED=1` in the gateway process environment and restart. Armed partial EXIT returns `partial_exit_protection_transition_unproven` again. Unset the variable and restart to restore the saga path.

**Evidence fixtures:** `tests/fixtures/projectx/live/partial_exit_protection_transition.json` (SHORT) and `partial_exit_protection_transition_long.json` (LONG).

Legacy `GLITCH_PARTIAL_EXIT_ACCEPTANCE=1` is no longer required for admission.

## Armed acknowledgement

The scaffold requires:

```text
GLITCH_TRADING_MODE=armed
GLITCH_ARMED_ACK=I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY
```

This exists only to prevent accidental activation. Do not use it as a substitute for the handoff gates.

## Local API

All sensitive endpoints require:

```text
Authorization: Bearer <GLITCH_LOCAL_TOKEN>
```

Operator controls require the separate `GLITCH_OPERATOR_TOKEN`.

Keep the server bound to `127.0.0.1`. Do not expose port 8790 to the LAN or internet.

Topstep flatten (`GLITCH_SESSION_MUST_FLAT_LOCAL_TIME`, default 15:10 CT) closes `session.entry_window_open` until the trading-day reset (17:00 CT). Quotes may still flow; ProjectX order mutations can fail with "instrument is not in an active trading status". Hermes skips flat ENTER when the window is closed.

Inspect sanitized REST reconciliation envelopes with `GET /evidence?source=projectx_rest` (Bearer `GLITCH_LOCAL_TOKEN`).

## Break-glass (main branch protection)

`main` enforces admin rulesets (`enforce_admins=true`), required checks (`test`, `dependency-review`, `codeql`), CODEOWNERS review, conversation resolution, and no force-push/deletion.

Break-glass is only for restoring a broken production path when CI or review would strand the trader. It is not a shortcut for ordinary merges.

1. Record the reason, start UTC, and expected end UTC in the PR / incident note (max **4 hours**).
2. Disable admin enforcement temporarily:
   `gh api -X DELETE repos/GlitchTrader/glitch-topstep/branches/main/protection/enforce_admins`
3. Land the minimal fix via PR when possible; direct push only if the PR path is itself broken.
4. Re-enable immediately:
   `gh api -X POST repos/GlitchTrader/glitch-topstep/branches/main/protection/enforce_admins`
5. Verify `enforce_admins.enabled` is `true` and open a follow-up issue if any required check was bypassed.

Never leave `enforce_admins` disabled overnight. Profile repo break-glass follows the same time box and audit note (`GlitchTrader/glitch-topstep-hermes-profile`).

## Armed promotion gate (human + evidence)

Local `.env` flags alone are not a release. Promoting a pair to armed production requires:

1. **Runtime ack** — `GLITCH_TRADING_MODE=armed` plus `GLITCH_ARMED_ACK=I_UNDERSTAND_THIS_SCAFFOLD_IS_NOT_LIVE_READY` on the trader device.
2. **GitHub Environment `armed-production`** — required reviewer, `can_admins_bypass=false`, protected branches only. Both `paired-release-candidate` (gateway) and `profile-release-candidate` (Hermes profile) use this environment.
3. **Evidence** — workflow input `evidence_ref` must point at PRAC/shadow proof (docs path or issue URL). Empty evidence is rejected by process; the paired manifest records `prac_or_shadow_evidence_ref`.
4. **Immutable pair** — run gateway `paired-release-candidate` with exact profile commit + `SHA256SUMS` hash + prompt version; artifacts include CycloneDX SBOM, `paired-release.json`, checksums, and provenance attestation.
5. **Ledger** — attach artifact names + evidence ref to `docs/ledger/ledger.json` / issue #116 before claiming a new armed promotion.

Dispatch example (gateway, from `main`):

```powershell
gh workflow run paired-release-candidate.yml `
  -f profile_commit=<profile-sha> `
  -f profile_version=0.2.0 `
  -f profile_manifest_sha256=<sha256-of-profile-SHA256SUMS> `
  -f prompt_version=glitch-topstep-v10 `
  -f evidence_ref=docs/evidence/<prac-or-shadow>.md
```

## Secret handling

- never commit `.env`
- never send the API key to Hermes
- never write the API key or JWT to logs
- store production secrets in the local OS credential store
- rotate the API key after any suspected exposure
- ensure ledger payloads cannot contain authorization headers

## Failure behavior

The correct default is no new entry.

No entry when:

- REST login or session validation fails
- either SignalR hub is disconnected or unreconciled
- account, position, order, or quote state is stale
- state completeness is false
- account identity differs from configuration
- contract identity differs from configuration
- the decision snapshot hash differs
- session policy is closed or unknown
- monetary risk exceeds budget
- working orders or an existing instrument position are present in the initial implementation

Risk-reducing exits should remain available after the corresponding ownership and stale-state rules are explicitly implemented.

## Bracket verification failure (`protection_status: failed`)

When SL/TP children are not observed within **30 seconds** of fill (`BRACKET_VERIFICATION_TIMEOUT_MS`), the decision packet exposes `protection.protection_status: failed` and the entry receipt code becomes `entry_protection_verification_failed`. The gateway does **not** auto-flatten.

Operator steps:

1. Verify TopstepX account has **Auto OCO Brackets** enabled (not Position Brackets).
2. Check `/ownership` and TopstepX for missing protective orders.
3. Issue `EXIT` via Hermes if the position should be closed.
4. After partial scale-out, wait for `tranche_protection_rearmed` or restart reconcile — see `docs/PARITY.md` PM-3 notes.

## Comparative cognition evaluation (TS-EVAL-01)

Evaluation-only procedure — **never** promotes `armed` from replay scores.

1. Freeze a corpus under the Hermes profile state root: `state/minute-frames/*.json` (`glitch.topstep.minute_frame.v2`).
2. Archive paired state snapshots with decisions/receipts for each prompt version:
   - `baseline-state/decisions.jsonl` (+ optional `receipts.jsonl`)
   - `candidate-state/decisions.jsonl`
3. Build runs (Hermes profile repo):

```powershell
cd C:\Users\arifr\Projects\glitch-topstep-hermes-profile
$frames = "C:\path\to\frozen\minute-frames"
python scripts/run-frozen-cognition.py `
  --frames-dir $frames `
  --state-root C:\path\to\baseline-state `
  --prompt-version glitch-topstep-v9 `
  --output data\eval\baseline-run.json
python scripts/run-frozen-cognition.py `
  --frames-dir $frames `
  --state-root C:\path\to\candidate-state `
  --prompt-version glitch-topstep-v10 `
  --output data\eval\candidate-run.json
python scripts/evaluate-frozen-cognition.py `
  --baseline data\eval\baseline-run.json `
  --candidate data\eval\candidate-run.json `
  --output data\eval\cognition-diff.json
```

4. Inspect `glitch.topstep.cognition_diff.v1`: `changed_frames`, per-frame `action` / `rejection` / `abstention_classification` deltas. `armed_promotion_allowed` is always `false`.
5. Archive the diff under `docs/evidence/TS-EVAL-01-*.md` when closing acceptance.

Fixture corpus for CI: `glitch-topstep-hermes-profile/tests/fixtures/frozen_corpus/`.
