# Glitch NT adaptations for Glitch Topstep

Status: implementation roadmap

Date: 2026-08-20

Repositories: `GlitchTrader/glitch-topstep` and `GlitchTrader/glitch-topstep-hermes-profile`

## 1. Decision and non-negotiable policy

This roadmap adapts the best reusable capabilities from the NinjaTrader Glitch repositories without importing NinjaTrader platform assumptions into the Topstep/ProjectX core.

Two current Topstep behaviors are explicitly frozen by the operator and are not candidates for removal:

1. **Daily capture may block new entries.** Once authoritative realized PnL reaches the configured daily-capture target, the gateway may durably reject new `ENTER_LONG` and `ENTER_SHORT` intents. Position reduction, protection, recovery, and flatten remain available.
2. **Automatic breakeven remains intent-free.** When the daily-capture protection latch requires it, the gateway may tighten exact owned stops to breakeven without waiting for Hermes to emit `MOVE_STOP`.

Both automatic paths remain gateway-owned, exact-leg-owned, idempotent, auditable, and tighten-only. They must never loosen a stop, mutate a manual/foreign order, or prevent risk reduction. The authoritative existing implementation is [TS-CAP-02 #119](https://github.com/GlitchTrader/glitch-topstep/issues/119).

The roadmap does not import fixed strategy thresholds, NinjaTrader/WPF code, ChartTrader coupling, multi-account replication, guardian flatten behavior, fixed risk percentages, trade quotas, or hidden cognition gates.

## 2. Current verified baseline

The remote `main` branches already contain more NT-derived capability than the older local profile checkout suggested:

- `glitch.intent.v3` is the active profile output contract.
- Flat cognition runs on the documented five-minute cadence, while frame capture and positioned management run each minute.
- Multi-candidate completeness and ranking contracts exist.
- Durable top-level `PRICE_CROSS` and `SESSION_PHASE` wake triggers exist.
- Frozen trigger lifecycle semantics exist at the cognitive contract level.
- Selective `orderflow-liquidity`, `session-playbook`, and `post-trade-review` skills exist.
- Outcome syncing, decision episodes, similar-decision grouping, and cognitive candidate artifacts exist.
- Gateway multi-instrument observation, exact contract resolution, account-wide admission, lifecycle facts, protected amendments, daily capture, and autonomous breakeven paths exist.

The remaining work is therefore not a wholesale port. It is a sequence of authority corrections, runtime reliability, contract completion, safe dynamic selection, measurable forecasts, learning governance, observability, and builder guardrails.

## 3. Source-of-truth donor references

Use the NT repositories as design references, then translate every concept to ProjectX identity, Topstep policy, and the paired v3 protocol.

### Hermes operator and runtime

- [NT Hermes SOUL](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/SOUL.md)
- [Market scan skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-market-scan/SKILL.md)
- [Setup state skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-setup-state/SKILL.md)
- [Order-flow skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-order-flow/SKILL.md)
- [Market-structure skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-market-structure/SKILL.md)
- [Position-management skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-position-management/SKILL.md)
- [Build-intent skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-build-intent/SKILL.md)
- [Learning skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-learn/SKILL.md)
- [Runtime skill](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/skills/glitch-runtime/SKILL.md)
- [Learning pipeline repair](https://github.com/GlitchTrader/glitch-hermes-profile/blob/main/docs/learning-pipeline-repair.md)

### Cross-layer contracts and reliability

- [Hermes operator contract](https://github.com/GlitchTrader/glitch/blob/main/glitch_hermes_docs/docs/10_hermes_operator_contract.md)
- [Snapshot ingestion and learning pipeline](https://github.com/GlitchTrader/glitch/blob/main/glitch_hermes_docs/docs/11_snapshot_ingestion_learning_pipeline.md)
- [Trading skills and knowledge](https://github.com/GlitchTrader/glitch/blob/main/glitch_hermes_docs/docs/12_hermes_trading_skills_and_knowledge.md)
- [Three-layer handoff](https://github.com/GlitchTrader/glitch/blob/main/glitch_hermes_docs/docs/13_three_layer_handoff.md)
- [Intent v3 reliability](https://github.com/GlitchTrader/glitch/blob/main/glitch_hermes_docs/docs/14_intent_v3_reliability.md)

### Builder workflow skills

- [Work routing](https://github.com/GlitchTrader/glitch/blob/main/.codex/skills/glitch-route-work/SKILL.md)
- [API guardrails](https://github.com/GlitchTrader/glitch/blob/main/.codex/skills/glitch-api-guardrails/SKILL.md)
- [AddOn/indicator workflow](https://github.com/GlitchTrader/glitch/blob/main/.codex/skills/glitch-addon-indicator-workflow/SKILL.md)
- [Documentation discipline](https://github.com/GlitchTrader/glitch/blob/main/.codex/skills/glitch-documentation-discipline/SKILL.md)
- [Deploy workflow](https://github.com/GlitchTrader/glitch/blob/main/.codex/skills/glitch-deploy-workflow/SKILL.md)

## 4. Priority model

- **P0 — correctness and authority:** a defect can create contradictory behavior, concurrent model ownership, unbounded risk semantics, or an unreliable paired contract.
- **P1 — decision quality with safe boundaries:** improves selection, timing, attribution, and learning while remaining non-gating and single-exposure.
- **P2 — operability and maintainability:** improves SOUL modularity, overlay governance, console visibility, and builder safety after the core contracts stabilize.
- **P3 — evidence-gated scale:** simultaneous multi-instrument exposure stays disabled until portfolio-risk, recovery, and fault-injection evidence are complete.

Product priority and delivery order are related but not identical. A low-risk P2 builder guardrail may be delivered early to reduce risk in later P0/P1 work; it does not become a runtime dependency.

## 5. Correct implementation order

### Wave 0 — Freeze invariants and publish the paired contract

Priority: P0 foundation

Primary issue: [TS-REAUDIT-09 #192](https://github.com/GlitchTrader/glitch-topstep/issues/192)

Objectives:

- Add paired fixtures that prove the daily-capture entry lock and intent-free automatic breakeven still behave exactly as required.
- Publish one versioned distributed contract for packet lease, intent registration, mutation state, receipt, outbox, controls, recovery, and terminality.
- Add amendment-source and selected-contract handoff fields before implementing behavior that depends on them.
- Declare cadence in the compatibility manifest and test it as configuration, not as trade eligibility.
- Establish one exact gateway/profile release pair for every subsequent wave.

Required contract additions:

- `amendment_source`: `HERMES_INTENT`, `AUTO_BREAKEVEN`, `AUTO_DAILY_CAPTURE`, or recovery/protection repair.
- `original_risk_envelope`: immutable entry-time maximum protected loss, stop boundary, fees/slippage reserve, scope identity, and version.
- selected candidate handoff identity: comparison decision, exact candidate root, executable contract scope, lease generation, range, and expiry.
- model-owner state: owner kind, invocation ID, process identity, acquired time, priority, and preemption state.
- outcome chronology version and evidence-quality flags.

Exit gate:

- Gateway and profile consume the same paired fixture corpus.
- Unknown versions fail closed without deleting outbox/recovery state.
- Preserved daily-capture and automatic-breakeven fixtures are green.
- No later wave invents a private duplicate schema.

### Wave 1 — Eliminate concurrent Hermes CLI ownership

Priority: P0

Issue: [GTHP-RUNTIME-01 #145](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/145)

Problem:

- Direct cognition owns `direct-cycle.lock`.
- Learning owns `learning-cycle.lock`.
- The learner checks the direct lock, but the two admissions are not one atomic operation.
- A race can start two Hermes CLI processes, especially around cron/wake boundaries on Windows.

Implementation slices:

1. Introduce a single atomic per-profile model-owner lock.
2. Put direct cycle, output repair, all learning loops, and future model callers behind it.
3. Encode priority: positioned/direct cognition first, flat cognition second, learning third.
4. Preserve derived learning evidence before defer/preemption.
5. Centralize Windows process creation, timeout, tree termination, text encoding, and hidden-window behavior.
6. Add owner-aware stale-lock recovery using PID plus process start identity; never kill by PID alone.
7. Publish waiting, deferred, preempted, recovered, failed, and completed state.

Test matrix:

- barrier-controlled direct/learning simultaneous admission;
- wake monitor plus scheduled learning collision;
- positioned cycle preempts learner;
- timeout with child process;
- process crash and PID reuse;
- pause, update, reset, and Windows path containing spaces;
- no loss of outbox, decisions, outcomes, or derived episodes.

Exit gate:

- No two workers can own the Hermes CLI simultaneously.
- Trading priority is deterministic and observable.
- Learning resumes exactly once or remains durably deferred.

### Wave 2 — Correct stop-amendment authority without weakening automatic protection

Priority: P0

Issue: [TS-AUTH-02 #197](https://github.com/GlitchTrader/glitch-topstep/issues/197)

Problem:

- The profile SOUL says Hermes may tighten or move a stop farther away when evidence supports it.
- Gateway amendment safety rejects every widening as `stop_would_widen`.
- Automatic protection and intentional structural management are currently forced through the same tighten-only rule.

Implementation rule:

- `AUTO_BREAKEVEN` and `AUTO_DAILY_CAPTURE` stay no-intent and tighten-only.
- A Hermes `MOVE_STOP` may widen only inside the immutable original approved risk envelope and the current hard-loss-floor envelope.
- Recovery repair may restore only proven intended protection; it cannot create a new cognitive amendment.

Required calculations:

- exact current owned stop/tranche quantity;
- before/after protected worst-case loss in native tick economics;
- original approved entry risk including fees and slippage reserve;
- current account-wide positions, working/pending entries, hard loss floor, and daily-capture entry state;
- market-side validity and exact tick alignment;
- remaining independently protected tranche coverage.

Required evidence:

- source, initiator, intent ID when applicable, original risk-envelope ID, prior/new price, prior/new protected loss, provider leg ID hash, receipt state, and rejection code.

Exit gate:

- Automatic breakeven still works without an intent and never loosens a stop.
- Daily capture still blocks new entries after authoritative realized target attainment.
- Valid structural widening works only within the original risk ceiling.
- No foreign/manual order or sibling leg is modified.

### Wave 3 — Produce learning-grade path chronology

Priority: P1, prerequisite for calibrated forecast and safer self-learning

Issue: [TS-OUTCOME-02 #198](https://github.com/GlitchTrader/glitch-topstep/issues/198)

Implementation slices:

1. Version the canonical outcome schema additively.
2. Record MFE/MAE price, ticks, timestamps, and evidence quality.
3. Record first passage through entry/breakeven after fill.
4. Track every stop/target amendment interval and first touch under that active geometry.
5. Preserve partial-fill, partial-exit, and tranche identity.
6. Mark same-event and retained-evidence gaps unresolved.
7. Rebuild the same chronology from the provider journal during deterministic replay.
8. Publish paired frozen fixtures for profile learning.

Do not infer tick ordering from OHLC when authoritative intra-bar evidence is missing. A descriptive unresolved result is safer than a false target-before-stop label.

Exit gate:

- Replay and live projection hash identically for the same retained evidence.
- Profile can separate market thesis, execution fidelity, and data incompleteness.

### Wave 4 — Connect candidate triggers to real wake scheduling

Priority: P1

Issue: [GTHP-TRIGGER-02 #146](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/146)

Problem:

- Candidate ledgers preserve textual CURRENT/BULLISH/BEARISH/NEXT paths.
- Only top-level `PRICE_CROSS` and `SESSION_PHASE` objects drive the wake monitor.
- Scanner candidate triggers therefore do not yet form an end-to-end typed scheduler contract.

Implementation slices:

1. Replace or augment `INSTRUMENT_COMPARISON_V1` with a native typed v2 representation.
2. Give every candidate path a stable trigger ID, source decision, instrument scope, condition, invalidation, expiry, and replacement rule.
3. Project eligible paths into the local wake document; keep them out of `glitch.intent.v3` gateway wire data.
4. Wake one account-global review when a trigger fires.
5. Emit `TRIGGER_REVIEW_V1` with HELD, FAILED, or EXPIRED classification.
6. Preserve unrelated candidates and paths.
7. Feed trigger outcomes into decision episodes and learning.

Exit gate:

- A fired path wakes exactly one review.
- A HELD trigger does not force entry.
- Failed or expired paths remain attributable.
- Five-minute flat cadence remains the fallback; positioned management remains one minute.

### Wave 5 — Execute the globally selected candidate, still single-exposure

Priority: P1

Issues: [GTHP-MULTI-02 #147](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/147), [TS-DATA-01 #171](https://github.com/GlitchTrader/glitch-topstep/issues/171)

Prerequisite gate:

- Do not expand per-candidate order flow or native comparison payload until TS-DATA-01 Phase D metrics justify it after at least five stable sessions.
- Candidate evidence classes must be symmetric. Missing evidence stays missing and explicit; no zero-fill or MNQ-favoring default.

Implementation slices:

1. Produce one complete account-global comparison.
2. Select exactly one candidate or global NOTHING.
3. Resolve the selected root to a fresh exact ProjectX contract scope.
4. Obtain a current packet/lease/range for that contract.
5. Revalidate identity, generation, expiry, quote, daily capture, capacity, hard loss floor, and geometry at delivery time.
6. Emit one v3 intent or record an attributable selection/delivery failure.
7. Keep all non-selected candidates observation-only.
8. Serialize new-exposure admission account-wide.

Explicit exclusions:

- no simultaneous independent decisions;
- no fallback to MNQ after selected-contract failure;
- no reuse of a packet lease from another contract;
- no expansion of risk by multiplying per-instrument capacity;
- no change to autonomous management of an already-open exact contract.

Exit gate:

- MNQ, MES, and MCL/MCLE can each be selected and executed from the same global flow.
- One stale or rolled selection fails safely and visibly.
- The daily-capture lock blocks selected new exposure regardless of instrument.

### Wave 6 — Add optional probabilistic forecasts and calibration

Priority: P1

Issue: [GTHP-FORECAST-01 #148](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/148)

Implementation slices:

1. Define optional local decision metadata for continuation, reversal, target-before-stop, expected path/regime, horizon, and uncertainty.
2. Validate only shape, finite range, identity, and version.
3. Remove metadata from gateway wire data unless a future audit-only additive contract accepts it.
4. Join forecasts to exact outcome/path chronology.
5. Group calibration only across compatible prompt/schema version, instrument, horizon, geometry, and evidence quality.
6. Publish reliability/Brier summaries with sample size and uncertainty.
7. Compare on the frozen cognition corpus before using the fields in prompts or overlays.

Stop line:

- No minimum confidence gate.
- No automatic `NOTHING` based on forecast probability.
- No sizing formula derived from forecast probability.
- No claim of calibration when samples are sparse or evidence is unresolved.

Exit gate:

- Metadata improves review and learning but cannot authorize or reject an intent.

### Wave 7 — Govern cognitive overlay promotion

Priority: P2

Issue: [GTHP-OVERLAY-01 #149](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/149)

Implementation lifecycle:

1. `proposed`: exact source episodes, prompt/schema version, expected effect, metric, contradictions, and rollback condition.
2. `holdout_evaluated`: tested on a frozen corpus that excludes training episodes.
3. `shadow`: visible in evaluation but no trading influence.
4. `canary`: bounded influence with exact decision attribution.
5. `active`: promoted only after cross-session evidence and adverse-regression review.
6. `expired`: TTL reached pending revalidation.
7. `rolled_back`: prior known version restored, history retained.

Required controls:

- cross-session and evidence-quality minimums;
- prompt/schema compatibility quarantine;
- separate market thesis metrics from execution failures;
- contradiction review;
- exact active overlay IDs on every influenced decision;
- automatic rollback on explicit adverse condition;
- append-only audit and reproducible frozen comparison.

Exit gate:

- An overlay cannot train and pass on the same episodes.
- Sparse success cannot silently become durable trading doctrine.
- Rollback is deterministic and preserves evidence.

### Wave 8 — Refactor SOUL into Topstep-native cognition skills

Priority: P2

Issue: [GTHP-SKILLS-01 #150](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/150)

Target skills:

- `topstep-market-scan`: complete symmetric candidate records, rank after completeness, global NOTHING allowed.
- `topstep-setup-state`: CURRENT/BULLISH/BEARISH/NEXT, prior trigger review, invalidation, expiry, and state transition.
- `topstep-orderflow-liquidity`: tape/DOM interpretation with reconstruction and freshness limits; absence is uncertainty, not veto.
- `topstep-market-structure`: timeframe roles, location, auction state, continuation/reversal alternatives, and no indicator voting.
- `topstep-position-management`: active management, exact tranches, structural amendments, autonomous protection distinction, and exit/reduction authority.

SOUL should retain only:

- identity and operator relationship;
- ProjectX/Topstep/gateway/Hermes authority;
- credential and provider-ID boundaries;
- long-run objective and no-fixed-strategy doctrine;
- immutable daily-capture and automatic-breakeven authority split;
- intent schema and supported-action discipline;
- learning/promotion boundaries;
- skill routing and stop lines.

Refactor method:

1. Add or refine skills first.
2. Add prompt snapshot and semantic invariant tests.
3. Route SOUL sections to skills.
4. Remove duplicated procedural prose only after tests prove equivalent obligations.
5. Re-run frozen cognition comparisons for action distribution, malformed outputs, hidden gates, and directional skew.

Exit gate:

- SOUL is materially shorter and easier to audit.
- No schema, authority, cadence, or policy behavior changes as a side effect.

### Wave 9 — Add a local authenticated operator console

Priority: P2

Issue: [TS-CONSOLE-01 #199](https://github.com/GlitchTrader/glitch-topstep/issues/199)

Read surfaces:

- exact paired release identity and compatibility;
- gateway mode, provider/session health, reconnect generation, and data age;
- daily-capture target/latch and autonomous breakeven status;
- position, exact tranches, protection, pending mutations, ambiguity, and recovery;
- latest packet, selected candidate, triggers, decisions, receipts, execution facts, outcomes, and learning status;
- acceptance evidence and bounded export.

Control surfaces:

- pause/resume cognition;
- shadow/armed request through existing authorization;
- cancel a pending operator directive;
- explicit reduce/flatten workflow through existing gateway state machines;
- bounded evidence export.

Security and authority:

- loopback-only default;
- separate read and control credentials;
- no credentials/provider IDs in browser state or logs;
- no direct ProjectX mutation;
- no strategy logic;
- no control bypass for daily capture, protection, recovery, or hard loss floor.

Exit gate:

- Console failure cannot affect gateway execution.
- Every mutation is confirmed, audited, and uses existing APIs.

### Wave 10 — Add repository-native builder guardrails

Priority: P2 product value; may be delivered in parallel with Wave 0 because it is low-risk

Issue: [TS-DEVEX-01 #200](https://github.com/GlitchTrader/glitch-topstep/issues/200)

Deliverables:

- a minimal root `AGENTS.md`;
- `topstep-route-work`;
- `topstep-projectx-contracts`;
- `topstep-execution-safety`;
- `topstep-hermes-pairing`;
- `topstep-live-acceptance`;
- `topstep-doc-ledger`;
- `topstep-release-pair`.

Each skill must define:

- when it activates;
- authoritative files and forbidden sources;
- repo ownership and paired-repo impact;
- required deterministic checks;
- required live/credentialed evidence where applicable;
- release, rollback, and documentation steps;
- stop lines for unsafe or unsupported work.

Exit gate:

- A builder can route work correctly without memorizing repository history.
- CI catches stale paths/metadata.
- Skills cannot enter the trading runtime.

### Wave 11 — Simultaneous multi-instrument exposure remains deferred

Priority: P3, disabled by default

Issue: [TS-MULTI-04 #126](https://github.com/GlitchTrader/glitch-topstep/issues/126)

This is not required for safe dynamic candidate selection. Do not begin until all of the following are proven:

- exact single-exposure selection across at least two products;
- account-wide atomic admission;
- independent exact-contract protection and recovery;
- portfolio protected-loss simulation with fees/slippage;
- pending-entry and partial-fill accounting;
- correlated exposure policy;
- restart, reconnect, rollover, stale-data, and one-contract-unprotected fault injection;
- daily capture and autonomous breakeven behavior across the whole account;
- paired simulation soak and explicit operator promotion.

## 6. Dependency chain

The critical path is:

1. paired state-machine contract and preserved-policy fixtures (#192/#119);
2. shared Hermes CLI ownership (#145);
3. amendment authority split (#197);
4. exact outcome chronology (#198);
5. typed candidate trigger runtime (#146);
6. safe selected-candidate delivery (#147), after TS-DATA-01 Phase D gate (#171);
7. probabilistic forecast/calibration (#148), using exact chronology;
8. overlay promotion lifecycle (#149);
9. SOUL/skill decomposition (#150) after contracts are stable;
10. operator console (#199) after status/control APIs stabilize;
11. simultaneous exposure (#126) only after independent portfolio-risk proof.

TS-DEVEX-01 (#200) can run beside steps 1–3 and should be finished before large cross-repository implementation waves.

## 7. PR slicing and release discipline

Do not combine the roadmap into one implementation PR. Use small paired slices with one authority change per PR.

Recommended slices:

1. **Contract/baseline PR:** paired schemas, fixtures, compatibility manifest, no behavior change.
2. **Profile runtime PR:** shared model-owner lock and Windows subprocess handling.
3. **Gateway amendment PR:** source-aware stop rules and receipts.
4. **Gateway outcome PR:** chronology schema, projection, replay, and fixtures.
5. **Profile trigger PR:** comparison v2, persistence, monitor wiring, review episodes.
6. **Paired selection PRs:** profile selected-contract handoff plus gateway compatibility fixtures.
7. **Profile forecast PR:** optional metadata and offline calibration only.
8. **Profile overlay PR:** lifecycle, holdout, canary, TTL, rollback.
9. **Profile skills/SOUL PR:** skills first, then semantic-preserving SOUL reduction.
10. **Console PRs:** read-only first, authenticated controls second.
11. **Developer guardrail PR:** AGENTS/skills/CI link validation.

For every paired release:

- record exact gateway and profile commits;
- bump/version the compatibility manifest only when the contract changes;
- run clean install, upgrade, rollback, and path-with-spaces tests;
- run gateway build/test and full profile test suite;
- attach frozen paired fixtures;
- distinguish source-tested, replay-proven, PRAC-proven, and armed-promoted states;
- never infer profitability or live readiness from unit tests.

## 8. Global acceptance matrix

Every runtime change must cover the applicable cases below:

- long and short;
- flat and positioned;
- one and multiple tranches;
- partial fill and partial exit;
- duplicate intent and body conflict;
- provider reject and ambiguous transport;
- reconnect and generation change;
- process crash and Windows restart;
- rolled/inactive contract;
- stale or incomplete evidence;
- manual/foreign order coexistence;
- daily-capture lock active;
- automatic breakeven active;
- risk reduction during degraded state;
- replay equivalence and append-only attribution;
- exact paired version mismatch and rollback.

## 9. Success criteria for the completed roadmap

The adaptation is successful when:

- the two frozen automatic policies remain provably intact;
- Hermes trading and learning can never race for the model runtime;
- Hermes structural management and gateway autonomous protection have distinct, auditable authority;
- every scanner candidate has symmetric typed paths and real wake/review lifecycle;
- the globally selected contract can execute safely without enabling simultaneous exposure;
- forecasts are measurable but never gates;
- outcome chronology supports honest target-before-stop and MFE/MAE calibration;
- overlays have holdout, canary, expiry, revalidation, and rollback;
- SOUL becomes a concise constitution backed by focused Topstep skills;
- operators can inspect and control the system locally without platform coupling;
- builders follow repo-native guardrails and exact paired release discipline;
- simultaneous exposure remains off until portfolio-risk evidence, not architecture optimism, proves it safe.

## 10. Open issue index

Gateway:

- [#192 — versioned distributed state-machine contract](https://github.com/GlitchTrader/glitch-topstep/issues/192)
- [#197 — stop-amendment authority split](https://github.com/GlitchTrader/glitch-topstep/issues/197)
- [#198 — exact excursion and first-touch chronology](https://github.com/GlitchTrader/glitch-topstep/issues/198)
- [#199 — local authenticated operator console](https://github.com/GlitchTrader/glitch-topstep/issues/199)
- [#200 — AGENTS and repository guardrail skills](https://github.com/GlitchTrader/glitch-topstep/issues/200)
- [#171 — TS-DATA-01 Phase D evidence gate](https://github.com/GlitchTrader/glitch-topstep/issues/171)
- [#126 — deferred simultaneous multi-instrument exposure](https://github.com/GlitchTrader/glitch-topstep/issues/126)

Hermes profile:

- [#145 — shared Hermes CLI ownership](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/145)
- [#146 — typed candidate triggers wired to wake/review](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/146)
- [#147 — safe selected-candidate execution](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/147)
- [#148 — non-gating probabilistic forecast metadata](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/148)
- [#149 — cognitive overlay promotion lifecycle](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/149)
- [#150 — Topstep-native cognition skills and SOUL decomposition](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/issues/150)
