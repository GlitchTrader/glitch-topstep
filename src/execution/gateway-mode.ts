import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { AccountVenueSnapshot, RiskSettings, TradingMode } from "../domain/models.js";
import type { ProjectXAuthStatus } from "../projectx/auth-manager.js";
import { validateScaleIn } from "../ownership/scale-in.js";
import { isReconciliationCurrent } from "../state/venue-state.js";
import {
  evaluateSnapshotDataQuality,
  type SnapshotDataQuality,
} from "../state/data-quality.js";

export type EffectiveGatewayMode = "disabled" | "shadow" | "armed" | "degraded_armed";

export interface ExecutionGate {
  id: string;
  passed: boolean;
  detail?: string;
}

export interface ResolvedGatewayMode {
  configured: TradingMode;
  effective: EffectiveGatewayMode;
  downgradeReason: string | null;
}

export function resolveGatewayMode(
  configured: TradingMode,
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  now: Date = new Date(),
): ResolvedGatewayMode {
  if (configured === "disabled") {
    return { configured, effective: "disabled", downgradeReason: null };
  }
  if (configured === "shadow") {
    return { configured, effective: "shadow", downgradeReason: null };
  }

  const reasons = armedGateReasons(snapshot, risk, now);
  if (reasons.length === 0) {
    return { configured, effective: "armed", downgradeReason: null };
  }
  return {
    configured,
    effective: "degraded_armed",
    downgradeReason: reasons.join(","),
  };
}

export function gatewayModePermitsLiveOrders(mode: EffectiveGatewayMode): boolean {
  return mode === "armed";
}

/** EXIT / flatten: entry-only armed downgrades must not strand open exposure. */
export function gatewayModePermitsRiskReduction(mode: EffectiveGatewayMode): boolean {
  return mode === "armed" || mode === "degraded_armed";
}

export function buildExecutionGates(
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  recovery: ExecutionRecoveryStatus,
  tradingMode: "disabled" | "shadow" | "armed",
  maxContracts: number,
  now: Date = new Date(),
  auth?: Pick<ProjectXAuthStatus, "degraded">,
): ExecutionGate[] {
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  const gatewayMode = resolveGatewayMode(tradingMode, snapshot, risk, now);
  return [
    ...armedSafetyGates(snapshot, risk, quality),
    riskReductionGate(tradingMode, gatewayMode.effective, snapshot),
    newExposureGate(snapshot, recovery, tradingMode, quality, maxContracts, auth),
  ];
}

function riskReductionGate(
  tradingMode: "disabled" | "shadow" | "armed",
  effective: EffectiveGatewayMode,
  snapshot: AccountVenueSnapshot,
): ExecutionGate {
  if (tradingMode === "disabled") {
    return {
      id: "risk_reduction_technically_supported",
      passed: false,
      detail: "trading_disabled",
    };
  }
  if (snapshot.instrumentOpenContracts <= 0) {
    return { id: "risk_reduction_technically_supported", passed: true };
  }
  if (!gatewayModePermitsRiskReduction(effective)) {
    return {
      id: "risk_reduction_technically_supported",
      passed: false,
      detail: "gateway_mode",
    };
  }
  return { id: "risk_reduction_technically_supported", passed: true };
}

function armedSafetyGates(
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  quality: SnapshotDataQuality,
): ExecutionGate[] {
  const reconciliation = snapshot.operational.reconciliation;
  const reconciliationCurrent = isReconciliationCurrent(snapshot.operational);
  const quoteStale = quality.quoteAgeMs !== null && quality.quoteAgeMs > risk.maxQuoteAgeMs;

  return [
    {
      id: "state_complete",
      passed: quality.stateComplete,
      detail: quality.stateComplete ? undefined : quality.issues.join(","),
    },
    {
      id: "quote_stale",
      passed: !quoteStale,
      detail: quality.quoteAgeMs !== null
        ? `quote_age_ms=${quality.quoteAgeMs} max=${risk.maxQuoteAgeMs}`
        : undefined,
    },
    {
      id: "reconciliation_current",
      passed: reconciliationCurrent,
      detail: reconciliationCurrent
        ? undefined
        : `state=${reconciliation.state} generation=${reconciliation.generation} operational_generation=${snapshot.operational.generation}`,
    },
  ];
}

function newExposureGate(
  snapshot: AccountVenueSnapshot,
  recovery: ExecutionRecoveryStatus,
  tradingMode: "disabled" | "shadow" | "armed",
  quality: SnapshotDataQuality,
  maxContracts: number,
  auth?: Pick<ProjectXAuthStatus, "degraded">,
): ExecutionGate {
  const remainingCapacity = Math.max(0, maxContracts - snapshot.totalOpenContracts);
  const failed: string[] = [];
  if (auth?.degraded) {
    failed.push("auth_degraded");
  }
  if (tradingMode === "disabled") {
    failed.push("trading_disabled");
  }
  if (!quality.stateComplete) {
    failed.push("state_incomplete");
  }
  if (!snapshot.account.canTrade) {
    failed.push("can_trade");
  }
  if (snapshot.instrumentOpenContracts !== 0) {
    const scaleInLong = validateScaleIn(
      "ENTER_LONG",
      snapshot,
      snapshot.contract.id,
      snapshot.account.id,
    );
    const scaleInShort = validateScaleIn(
      "ENTER_SHORT",
      snapshot,
      snapshot.contract.id,
      snapshot.account.id,
    );
    if (!scaleInLong.allowed && !scaleInShort.allowed) {
      failed.push("scale_in_blocked");
    }
  } else if (snapshot.openOrders.length > 0) {
    failed.push("no_open_orders");
  }
  if (remainingCapacity <= 0) {
    failed.push("capacity");
  }
  if (recovery.blockingNewExposure) {
    failed.push("recovery");
  }

  const passed = failed.length === 0;
  return {
    id: "new_exposure_technically_supported",
    passed,
    detail: passed ? undefined : failed.join(","),
  };
}

function armedGateReasons(
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  now: Date,
): string[] {
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  const gates = armedSafetyGates(snapshot, risk, quality);
  const reasons: string[] = [];
  const stateGate = gates.find((gate) => gate.id === "state_complete");
  if (stateGate && !stateGate.passed) {
    reasons.push(...(stateGate.detail?.split(",") ?? ["venue_state_incomplete"]));
  }

  for (const gate of gates) {
    if (gate.id === "state_complete" || gate.id === "quote_stale" || gate.passed) {
      continue;
    }
    if (gate.id === "reconciliation_current") {
      reasons.push("reconciliation_not_current");
    }
  }

  return [...new Set(reasons)];
}
