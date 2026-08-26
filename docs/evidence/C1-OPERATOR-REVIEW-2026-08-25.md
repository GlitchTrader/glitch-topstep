# Operator review — C1 mutation no-retry (audit 2026-08-25)

**Policy:** mutação ambígua → reconciliar, nunca retry cego (`docs/ledger/audits/2026-08-25-complete-architecture-audit.md`)  
**Code baseline:** gateway `2f87964` (PR #240)  
**Automated proof:** `tests/projectx-client.test.ts` — `placeOrder` on HTTP 429 makes exactly 2 fetch calls (login + one mutation attempt, no retry)

---

## 1. Retry policy — mutações não retentam

| Path | `shouldRetryPost` on 429 | Verified |
|------|--------------------------|----------|
| `/api/Order/place` | **false** | [x] code + unit test |
| `/api/Order/modify` | **false** | [x] `isMutationPath` |
| `/api/Order/cancel` | **false** | [x] `isMutationPath` |
| `/api/Position/closeContract` | **false** | [x] `isMutationPath` |
| Non-mutation POST (e.g. login/search) | may retry 429 | [x] `shouldRetryPost` returns true for non-mutation |

**Files:** `src/projectx/retry-policy.ts`, `src/projectx/client.ts` (`post()` loop uses `shouldRetryPost`).

**Operator judgment:** Accept — mutation paths are hard-blocked from 429 retry; reads/auth paths unchanged.

---

## 2. Ambiguous outcome — reconciliação (não retry)

When a mutation returns without a durable provider identity, recovery reconciles by:

1. **`providerOrderId`** if already recorded → match order by id + identity fields (`recovery.ts` `reconcileEntryMutation`)
2. Else **`customTag`** (`glt-{intentId}`) → unique tagged order match; duplicate tag → ambiguous error
3. Missing both → `place_order_outcome_ambiguous:*` — **no automatic retry**

**Admission gate:** while ambiguity blocks recovery, `intent-admission.ts` rejects new exposure with `execution_recovery_required` / `entry_submission_pending`.

**Operator judgment:** Accept — ambiguous mutation blocks new exposure until historical orders prove outcome; aligns with TS-AUDIT-03.

---

## 3. Live PRAC spot-check (preflight coupling)

| Signal | Observed (2026-08-26 preflight) |
|--------|----------------------------------|
| Gateway rebuilt on `2f87964` | yes |
| `trading_mode=armed`, flat | yes |
| No `auth_degraded` / recovery block in health | yes |
| `evidence_queue_physical_depth` exposed | yes (0) |

No live 429 during preflight (expected — idle flat account). C1 live proof remains **scenario-dependent**; automated unit + recovery paths cover the policy.

---

## 4. Residual / monitoring

- If ProjectX returns 429 **after** accepting a mutation but before response body: rely on reconciliation loop + operator logs (`entry_submitted_pending_reconciliation` receipts). **Do not** re-enable mutation retry without explicit policy change.
- Watch for `execution_recovery_required` in receipts — indicates ambiguity awaiting provider proof.

---

## Sign-off

| Field | Value |
|-------|-------|
| Reviewer | `arifreund18` |
| Decision | **ACCEPT** — C1 policy implemented; reconciliation path reviewed |
| Signed at (UTC) | `2026-08-26T00:08:00Z` |
