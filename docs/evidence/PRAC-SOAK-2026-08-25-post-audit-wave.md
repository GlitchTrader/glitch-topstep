# PRAC preflight — pós audit wave 2026-08-25

**Recorded:** 2026-08-26 (local)  
**Paired baseline:** gateway `2f87964` (#240/#241) + profile `fa424ee` (#197/#198)  
**Prior armed sign-off:** 2026-08-25T01:46:34Z (`arifreund18`, pair_digest `78739f34…`)

## Procedure

1. `git pull` gateway `main` → `2f87964`
2. `npm run build`
3. Restart gateway (`start.ps1 -SkipBuild`) — new PID after stop of prior listener
4. `powershell -File scripts/prac-soak-checklist.ps1 -EvidenceDir docs/evidence/PRAC-SOAK-2026-08-25-post-audit-wave`

## Results — 6/6 PASS

| check | ok |
|-------|-----|
| gateway_version_0.2.2 | true |
| trading_mode_armed | true |
| lifecycle_ready | true |
| auth_not_degraded | true |
| state_complete | true |
| flat_start | true |

## Post-wave observability (new)

- `invariant_metrics.evidence_queue_physical_depth`: **0** (W5 metric present on rebuilt gateway)
- `evidence_queue.physical_depth`: **0**

## Health snapshot

- `status=ok`, `lifecycle.state=ready`, `unprotected_open_quantity=0`
- Evidence JSON: `docs/evidence/PRAC-SOAK-2026-08-25-post-audit-wave/gateway-health-preflight.json`

## Scope note

This is **preflight only** (single_active_position gate). It does not replace a 72h prolonged soak for autonomous armed promotion (PROD-08 residual).
