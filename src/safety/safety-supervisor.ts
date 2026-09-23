import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { AccountVenueSnapshot, RiskSettings, TradingMode } from "../domain/models.js";
import type { ProtectedReductionHealth } from "../execution/protected-reduction-saga.js";
import type { ProjectXAuthStatus } from "../projectx/auth-manager.js";
import { buildExecutionGates } from "../execution/gateway-mode.js";

/** Facts the execution gates do not compute. Everything else is a test, not a runtime copy. */
export const SUPERVISOR_UNIQUE_INVARIANTS = ["protection_coverage", "no_flatten_pending"] as const;

/** Gate ids that used to be recomputed here — must stay owned by buildExecutionGates. */
export const SUPERVISOR_GATE_BACKED_IDS = [
  "state_complete",
  "reconciliation_current",
  "new_exposure_technically_supported",
  "risk_reduction_technically_supported",
] as const;

export interface SafetyInvariant {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface SafetySupervisorEvaluation {
  /** Observe-only. Promotion to authority was declined 2026-09-23 (TS-REAUDIT-06). */
  mode: "observe";
  invariants: SafetyInvariant[];
  new_exposure_blocked: boolean;
  risk_reduction_permitted: boolean;
  would_block_new_exposure: boolean;
  agrees_with_execution_gates: boolean;
  gate_divergence_detail: string | null;
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
  const riskReductionGate = executionGates.find((gate) => gate.id === "risk_reduction_technically_supported");
  const newExposureBlockedByGates = newExposureGate ? !newExposureGate.passed : true;

  const invariants: SafetyInvariant[] = [
    invariant(
      "protection_coverage",
      input.protectedReduction.unprotected_open_quantity === 0,
      input.protectedReduction.unprotected_open_quantity > 0
        ? `unprotected_qty=${input.protectedReduction.unprotected_open_quantity}`
        : undefined,
    ),
    invariant("no_flatten_pending", !input.flattenPending, input.flattenPending ? "flatten_in_flight" : undefined),
  ];

  return {
    mode: "observe",
    invariants,
    new_exposure_blocked: newExposureBlockedByGates,
    risk_reduction_permitted: riskReductionGate?.passed ?? false,
    would_block_new_exposure: newExposureBlockedByGates,
    agrees_with_execution_gates: true,
    gate_divergence_detail: null,
  };
}
