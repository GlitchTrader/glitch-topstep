import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { AccountVenueSnapshot, RiskSettings, TradingMode } from "../domain/models.js";
import type { ProtectedReductionHealth } from "../execution/protected-reduction-saga.js";
import type { ProjectXAuthStatus } from "../projectx/auth-manager.js";
import {
  buildExecutionGates,
  gatewayModePermitsRiskReduction,
  resolveGatewayMode,
  type EffectiveGatewayMode,
} from "../execution/gateway-mode.js";
import { evaluateSnapshotDataQuality } from "../state/data-quality.js";
import { isReconciliationCurrent } from "../state/venue-state.js";

export interface SafetyInvariant {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface SafetySupervisorEvaluation {
  /** ponytail: observe-only until soak proves parity with execution gates. */
  mode: "observe";
  invariants: SafetyInvariant[];
  new_exposure_blocked: boolean;
  risk_reduction_permitted: boolean;
  would_block_new_exposure: boolean;
  agrees_with_execution_gates: boolean;
}

export interface SafetySupervisorInput {
  snapshot: AccountVenueSnapshot;
  risk: RiskSettings;
  tradingMode: TradingMode;
  runtimeTradingMode: TradingMode;
  operatorPaused: boolean;
  recovery: ExecutionRecoveryStatus;
  maxContracts: number;
  auth: ProjectXAuthStatus;
  protectedReduction: ProtectedReductionHealth;
  flattenPending: boolean;
  now?: Date;
}

function invariant(id: string, ok: boolean, detail?: string): SafetyInvariant {
  return detail ? { id, ok, detail } : { id, ok };
}

export function evaluateSafetySupervisor(input: SafetySupervisorInput): SafetySupervisorEvaluation {
  const now = input.now ?? new Date();
  const quality = evaluateSnapshotDataQuality(input.snapshot, input.risk, now);
  const gatewayMode = resolveGatewayMode(input.runtimeTradingMode, input.snapshot, input.risk, now);
  const reconciliationCurrent = isReconciliationCurrent(input.snapshot.operational);
  const executionGates = buildExecutionGates(
    input.snapshot,
    input.risk,
    input.recovery,
    input.tradingMode,
    input.maxContracts,
    now,
    input.auth,
  );
  const newExposureGate = executionGates.find((gate) => gate.id === "new_exposure_technically_supported");
  const newExposureBlockedByGates = newExposureGate ? !newExposureGate.passed : true;

  const invariants: SafetyInvariant[] = [
    invariant("operator_not_paused", !input.operatorPaused, input.operatorPaused ? "paused" : undefined),
    invariant("auth_not_degraded", !input.auth.degraded, input.auth.degraded ? "auth_degraded" : undefined),
    invariant("reconciliation_current", reconciliationCurrent),
    invariant("state_complete", quality.stateComplete, quality.stateComplete ? undefined : quality.issues.join(",")),
    invariant(
      "protection_coverage",
      input.protectedReduction.unprotected_open_quantity === 0,
      input.protectedReduction.unprotected_open_quantity > 0
        ? `unprotected_qty=${input.protectedReduction.unprotected_open_quantity}`
        : undefined,
    ),
    invariant("no_flatten_pending", !input.flattenPending, input.flattenPending ? "flatten_in_flight" : undefined),
    invariant(
      "event_ledger_durable",
      !input.recovery.blockingAmbiguity,
      input.recovery.blockingAmbiguity ? "execution_recovery_ambiguity" : undefined,
    ),
  ];

  const failedIds = invariants.filter((entry) => !entry.ok).map((entry) => entry.id);
  const wouldBlockNewExposure = failedIds.length > 0
    || input.tradingMode !== "armed"
    || gatewayMode.effective !== "armed";

  const riskReductionPermitted = gatewayModePermitsRiskReduction(gatewayMode.effective)
    && input.tradingMode !== "disabled";

  return {
    mode: "observe",
    invariants,
    new_exposure_blocked: newExposureBlockedByGates,
    risk_reduction_permitted: riskReductionPermitted,
    would_block_new_exposure: wouldBlockNewExposure,
    agrees_with_execution_gates: wouldBlockNewExposure === newExposureBlockedByGates,
  };
}

export function effectiveGatewayModeLabel(mode: EffectiveGatewayMode): string {
  return mode;
}
