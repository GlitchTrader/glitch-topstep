# Evidence inventory (human pass, 2026-09-23)

Classification of **tracked** top-level paths under `docs/evidence/` as of `origin/main`. Local untracked dumps, probes, and `__pycache__` stay out of git.

Do not treat this file as a deletion license. Soak and PROD/TS-BETA folders stay on disk.

## Keep — current operations / acceptance

| Path | Why it stays live |
|------|-------------------|
| `PRAC-SOAK-2026-08-21/` | First PRAC soak + health preflight cited by armed-promotion evidence |
| `PRAC-SOAK-2026-08-21-single-active-position.md` | Position-scope soak note |
| `PRAC-SOAK-2026-08-25-post-audit-wave` + `.md` | Post-wave soak |
| `PRAC-SOAK-2026-08-31/` | Later soak package; promotion still gated |
| `PRAC-OVERNIGHT-20260911/` | Overnight PRAC package |
| `FLAT-IDLE-USER-STREAM-PREMISE-20260922/` | Stream-idle premise (does **not** close `TS-STREAM-RECOVERY-01`) |
| `LLM-RESTORE-20260922/` | LLM restore evidence |
| `gateway-diagnosis/` | Operator diagnosis trail (keep; do not bulk-trim) |
| `gateway-pre-smoke-20260911/` | Pre-smoke / preflight snapshots used in later reviews |
| `quote-bbo-assembler-release-offline/` | Quote assembler release pair |
| `quote-missing-root-cause-2026-09-09.json` | BBO gap root cause |
| `2026-09-14-ensemble-audit-provenance-manifest.md` | Ensemble provenance |

## Keep — frozen proofs (ledger / parity still point here)

| Path | Note |
|------|------|
| `TS-BETA-01-immutable-baseline-2026-08-04.md` | Immutable beta baseline |
| `TS-EVAL-01-frozen-cognition-proof-2026-08-20.md` | Frozen cognition |
| `EXEC-01-lifecycle-facts-proof-2026-08-20.md` | Lifecycle facts |
| `ISSUE-74-structural-packet-proof-2026-08-20.md` | Packet structure |
| `MULTI-01-02-03-proof-2026-08-20.md` | Multi-instrument |
| `PROD-05-backpressure-proof-2026-08-20.md` | Backpressure |
| `PROD-06-state-machines-proof-2026-08-20.md` | Historical snapshot: still names ExecutionSaga / ProtectionSaga. Live graphs are the five machines in `release/distributed-state-machine.v1.json`. |
| `PROD-08-protection-proof-2026-08-20.md` | Protection |

## Historical — profile re-audit twins (do not delete)

These are dated re-reads of already-landed work. Keep as audit trail; they are not a current promotion gate.

| Path |
|------|
| `SHADOW-SMOKE-HERMES-FAILED-REAUDIT-20260911/` |
| `SHADOW-SMOKE-R2-FINAL-REAUDIT-20260911/` |
| `SKILL-WIRING-PROMOTION-REAUDIT-20260911/` |
| `COGNITION-AGGREGATION-CONTRACT-REPAIR-AUDIT-20260910/` |
| `COGNITION-DECISION-AUDIT-20260910/` |
| `LLM-PROMPT-QUALITY-AUDIT-20260910/` |
| `NORMALIZATION-REPAIR-AUDIT-20260910/` |
| `PROMPT-REGRESSION-MULTIMARKET-AUDIT-20260910/` |
| `PRAC-EXTENDED-AUDIT-20260910-4e7a1c6d2f48a0b5e3c7f9d1a6b8e2/` |

## Historical — dated release / pairing artifacts

| Path | Note |
|------|------|
| `ARMED-PROMOTION-CHECKLIST-2026-08-24.md` | Execution record of that day's ceremony. Live checklist is `docs/OPERATIONS.md`. |
| `C1-OPERATOR-REVIEW-2026-08-25.md` | Operator review that day |
| `paired-release-5813d83/` | Immutable paired-release artifact (includes old DSM keys) |
| `entry-parity-prompt-eval-2026-08-26T*.{intent,meta,prompt}.*` | Prompt-eval snapshots |

## Out of scope this pass

- Untracked local folders (CONTROLLED-VALIDATION-*, MULTIMARKET-FREEZE-*, PRAC-ACCEPTANCE-*, gateway-diagnosis run dirs, `*.jsonl` probes). Do not `git add`.
- No bulk delete of soaks.
- Stream 72h soak (`TS-STREAM-RECOVERY-01`) remains open; nothing here substitutes for it.
