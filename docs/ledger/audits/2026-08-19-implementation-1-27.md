# Implementation audit — roadmap 1–27

Date: 2026-08-19

## Symbol authority

Topstep names Micro Crude Oil as `MCL`. ProjectX currently exposes the captured active product family as `MCLE` (`F.US.MCLE`) and exact contracts such as `CON.F.US.MCLE.U26`. Operator configuration and cognition use `MCL`; the gateway resolves the exact active provider contract from the authenticated catalog. Missing or ambiguous resolution fails closed. No contract ID is synthesized.

## Implemented groups

1. Supply chain and governance: least-privilege CI, immutable action commits, deterministic installs, dependency review, CodeQL, CODEOWNERS, release SBOM/checksums/provenance workflow, paired manifest generator, and a separate protected release environment. GitHub `main` protection, secret scanning, push protection, and Dependabot security updates were enabled in both repositories.
2. Lifecycle and persistence: exclusive runtime lock, stale-owner recovery, explicit lifecycle supervisor, reverse shutdown drain, recoverable writer chains, fsync/atomic replace, persistence health, revisioned SQLite outcomes, durable controls, and cursor feeds.
3. Execution safety: protocol v3, exact packet/contract/scope/generation/expiry/range binding, latest-price revalidation, supersession, immediate execution facts, and armed partial EXIT fail-closed until ProjectX behavior is proven.
4. Participation contract: explicit current partial/prior completed bars and a configurable 0.5% daily-capture context. It is never an entry trigger, quota, direction, or sizing input. Reaching it latches a durable new-exposure lock for the trading day.
5. Hermes pairing: strict protocol/capability/revision/evidence intersection, complete candidate comparison ledger, immutable trigger source/status contract, one delivery reassessment, truthful worker status, revision-aware outcome replacement, prompt-version attribution, and transport/execution facts kept separate from directional lessons.
6. Evaluation and scanner: frozen-corpus A/B diff harness; MNQ/MES/MCL universe with MCL→MCLE catalog resolution; exact tick economics and scope hash; centralized rate-aware bars; one reconnecting market hub; bounded optional depth; complete global ranking; account-wide additive protected downside; exact-contract execution scope; simultaneous exposure opt-in only.

## Benefits

- Removes identity drift between cognition and execution.
- Prevents stale or favorable price movement from silently widening permission.
- Preserves corrections and avoids duplicate learning episodes.
- Makes pause/mode/flatten and process ownership survive restart.
- Adds multi-instrument observation without cloning mutation owners.
- Keeps a positive daily direction while preserving abstention and risk truth.

## Residual risks and future improvements

These are validation or provider-bound gaps, not reasons to weaken fail-closed behavior:

- ProjectX partial-close/OCO behavior still needs sanitized PRAC evidence. Until then partial EXIT remains blocked in armed mode.
- The bounded evidence path still performs the authoritative SQLite commit synchronously before VenueState mutation. This is safe but may affect event-loop latency at extreme burst rates; run the soak matrix before considering a worker-thread redesign.
- Global cognition can rank any candidate, but executable exposure remains the exact contract selected at service startup. Switching to another ranked contract requires an intentional restart/configuration generation; hot switching should be a separate safety-reviewed change.
- Simultaneous cross-instrument admission is implemented and default-off. It still needs simulation evidence covering pending orders, correlated gaps, rollovers, and hard-floor exhaustion before enablement.
- Main protection, secret scanning, push protection, and Dependabot security updates were verified through the GitHub API. Non-provider-pattern scanning and validity checks remained unavailable/disabled; the `armed-production` environment still needs a reviewer configured in GitHub before release use.
- The cognition evaluator verifies immutable corpus identity and diffs actions/rejections/abstention, but a real two-model run must be captured before using its findings.
- Release provenance is produced by GitHub OIDC only when the protected manual release workflow runs; local builds are intentionally not represented as attested releases.
- Existing open positions are deliberately treated as unpriced/unprotected by the portfolio admission layer until exact stop geometry is available; this can reject scale-ins that are operationally safe, but prevents understated downside.
- Operator flatten now uses the durable EXIT/outbox path. A crash after a flatten submission still depends on the normal ProjectX reconciliation cycle to close the control record; an ambiguous non-flat restart remains paused and disabled for manual resolution.
- The release workflow now accepts only gateway/profile commits reachable from each repository's protected `main` history and disables checkout credential persistence. Signed-commit enforcement remains a repository-policy decision and is not assumed locally.
- A live `npm audit` rerun was unavailable in the restricted environment because the npm advisory endpoint could not be reached; the dependency lockfile was unchanged and the prior audit returned zero vulnerabilities.

## Validation protocol

1. Run `npm ci --ignore-scripts` and `npm run check` in the gateway.
2. Run Python compile plus the complete unittest discovery in the paired profile, then verify `SHA256SUMS`.
3. Start in simulation with `GLITCH_INSTRUMENT_ALLOWLIST=MNQ,MES,MCL`; verify `/scanner` has three exact, complete candidates and MCL resolves to MCLE family data.
4. Replay a stale/expired/range-breached v3 intent and verify attributable rejection without provider mutation.
5. Restart after durable pause/mode commands and outcome corrections; verify idempotent controls, cursor continuity, and one episode per outcome revision projection.
6. Run the kill/reconnect matrix and the evidence burst/soak suite; confirm no duplicate provider entries and no identity-event loss.
7. Run separate simulated armed sessions for MNQ, MES, and MCL. Keep simultaneous exposure disabled.
8. Capture the PRAC partial-exit matrix. Only a reviewed evidence artifact may change `not_proven_fail_closed`.
9. Run frozen cognition with two immutable prompt versions and archive the diff report; scores cannot promote armed mode.
10. Publish through the protected paired-release workflow and verify SBOM, SHA256SUMS, provenance, exact commits, profile manifest hash, and human evidence reference.
11. Verify operator controls with separate local and operator tokens; after a forced restart during `pause`, `set_mode`, and `flatten`, confirm the effective state is never more permissive than the durable command state.
