# Gateway authority re-evaluation for overnight soak — 2026-09-11

## Verdict

`blocked` — `gateway_supervised_overnight=false`

The gateway is **not** yet sufficient operational authority for unsupervised overnight under the stated release criteria. A separate Hermes process-restart watchdog is **not** the missing piece and is not recommended. The gap is fail-closed **auto-flatten / recovery action** when protection verification or rearm fails while Hermes is dead.

**Orders sent during this analysis:** `0`  
**Intents / resets / canary / promotion:** none

## Sync state at analysis time

| Repo | Local | `origin/main` | Notes |
|------|-------|---------------|-------|
| `glitch-topstep` | `50e68db` | `50e68db` | Fast-forwarded from detached `8cae531`; merged [#274](https://github.com/GlitchTrader/glitch-topstep/pull/274) |
| `glitch-topstep-hermes-profile` | `a1ac0f5` | `a1ac0f5` | Synced; [#232](https://github.com/GlitchTrader/glitch-topstep-hermes-profile/pull/232) still CONFLICTING (needs rewrite, not force-merge) |

Stale local branch tips that looked “ahead” are squash-merge leftovers; two-dot diffs against current `main` would delete newer code. No additional code PRs were required beyond #274.

## Criteria checklist

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Admitted order born with protection | **PASS** | ENTER places ProjectX Auto OCO brackets in `src/execution/coordinator.ts`; test `tests/execution-coordinator.test.ts` (“submits signed ProjectX bracket ticks…”) |
| 2 | Protection persists if Hermes dies | **PASS** | Protection is venue-side Auto OCO; gateway continue reconcile/rearm/breakeven without Hermes heartbeat (`docs/GATEWAY-SPEC.md`) |
| 3 | Reconcile + flatten/recovery autonomous | **PARTIAL** | Reconcile, rearm, orphan protective sweep, bounded ambiguous-entry flatten: yes. Generic flatten on `protection_status: failed`: **no** (`docs/OPERATIONS.md` — “The gateway does **not** auto-flatten.”) |
| 4 | Ambiguous state blocks new entries | **PASS** | `blockingNewExposure` in `sqlite-execution-store.ts` + `intent-admission.ts`; `tests/execution-recovery.test.ts`, `tests/kill-matrix.test.ts` |
| 5 | Health/packet loss blocks new entries | **PASS** | Packet expired / `state_complete` / quote stale / gates; `tests/risk-engine.test.ts`, `tests/gateway-mode.test.ts` |
| 6 | Orphan position detected and handled | **PARTIAL** | Orphan intent, protective sweep, rearm, bounded flatten: yes. Naked filled position after rearm failure: alert + journal only — **no** autonomous flatten |
| 7 | Reproducible tests for runner-death scenarios | **PARTIAL** | Strong kill-matrix for **gateway** process death; no Hermes-runner-death E2E with live position |
| 8 | Zero unprotected exposure invariant | **FAIL as absolute** | Soak evidence often shows `unprotected_open_quantity: 0`, but incident `PRAC-SOAK-2026-08-31` required **operator** flatten; safety supervisor is observe-only |

## Runner-death scenarios (gateway alive)

### A — No position

Idle reconcile. No exposure. New ENTER impossible without Hermes (and would still need valid packet/gates if intents appeared). Residual risk ~0.

### B — Pending order

Outbox `submitting`/`ambiguous` → `blockingNewExposure=true`. Recovery via custom tag / provider id. Owned + open position + ambiguous → `attemptBoundedRecoveryFlattens` (`recovery-flatten.ts`). Working entry without fill is not arbitrarily cancelled. Tests: `execution-recovery.test.ts`, `recovery-flatten.test.ts`, `kill-matrix.test.ts`.

### C — Filled + stop confirmed

Best overnight case: SL/TP on venue; gateway maintains ownership, may rearm OCO survivors, intent-free breakeven under daily capture. Discretionary EXIT/MOVE_STOP from Hermes stops. Tests: `receipt-reconciliation.test.ts` (open_protected), `execution-coordinator.test.ts` (capture tighten).

### D — Filled + loss of communication / brackets unobserved

After `BRACKET_VERIFICATION_TIMEOUT_MS` (30s) → `protection_status: failed` / `entry_protection_verification_failed`. Health elevates `unprotected_open_quantity`. `rearmTrancheProtection` may restore SL/TP. **No auto-flatten** — operator or Hermes EXIT required (`OPERATIONS.md`). **Unprotected window is real** until rearm succeeds or human/control flatten.

### E — Ambiguous receipt

Mutation stays ambiguous → blocks ENTER. Recovery by tag; bounded flatten when ownership proven. Duplicate intent → ambiguous / recovery-required receipts. Tests: `execution-recovery.test.ts`, `orphan-intent-recovery.test.ts`.

## Exact gap (not a restart supervisor)

| Item | Detail |
|------|--------|
| **Missing function** | Fail-closed autonomous flatten (or control-saga flatten) when `unprotected_open_quantity > 0` after protection verification failure **and** rearm exhausted/failed, without requiring Hermes EXIT |
| **Residual risk** | Naked position overnight if Auto OCO missing/cancelled and rearm rejects while runner is dead |
| **Missing test** | Hermes-death matrix: filled+pending protection, filled+confirmed stop, filled+rearm-fail → assert venue protection or gateway flatten; today kill-matrix covers gateway kill only |
| **Minimal change** | Wire protection-failed / rearm-failed path to existing `closePosition` / flatten control path (bounded, ownership-proven), and promote safety-supervisor `would_block_new_exposure` from observe-only to an execution gate if not already mirrored — **do not** add a process-restart watchdog |
| **Risk gates** | Unchanged; no relaxation |

## Why the prior overnight block was partially wrong

The 2026-09-11 soak block assumed an “official long-running supervisor” owning flatten on abnormal exit. Re-evaluation: for **confirmed** venue protection, Hermes death does not strip stops. The real overnight blocker is the documented non-auto-flatten on protection/rearm failure — a **gateway** capability gap, not absence of a Hermes babysitter.

## Actions taken / not taken

- Synced both repos to GitHub `main`; merged gateway #274; left profile #232 open with conflict note.
- Did **not** set `gateway_supervised_overnight=true`.
- Did **not** start smoke→overnight pipeline.
- Did **not** send orders, intents, or mutate live account state for this analysis.

## Release gate for future overnight

Only when all of the following are true and evidenced:

1. Protection-failed / rearm-failed → autonomous flatten path shipped + tested.
2. Hermes-death scenarios A–E covered by reproducible tests (or explicit acceptance that C is the only live overnight posture with proven brackets).
3. Soak/health shows sustained `unprotected_open_quantity=0` with no operator flatten required.
4. Runbook then sets `gateway_supervised_overnight=true` and may auto-chain one-envelope smoke → overnight with fail-stop.
