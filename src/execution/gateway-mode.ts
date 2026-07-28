import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { AccountVenueSnapshot, RiskSettings, TradingMode } from "../domain/models.js";
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
  orderFlow: ProjectXOrderFlowState,
  now: Date = new Date(),
): ResolvedGatewayMode {
  if (configured === "disabled") {
    return { configured, effective: "disabled", downgradeReason: null };
  }
  if (configured === "shadow") {
    return { configured, effective: "shadow", downgradeReason: null };
  }

  const reasons = armedGateReasons(snapshot, risk, orderFlow, now);
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

export function buildExecutionGates(
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  orderFlow: ProjectXOrderFlowState,
  recovery: ExecutionRecoveryStatus,
  tradingMode: "disabled" | "shadow" | "armed",
  maxContracts: number,
  now: Date = new Date(),
): ExecutionGate[] {
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  return [
    ...armedSafetyGates(snapshot, risk, orderFlow, quality),
    newExposureGate(snapshot, recovery, tradingMode, quality, maxContracts),
  ];
}

function armedSafetyGates(
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  orderFlow: ProjectXOrderFlowState,
  quality: SnapshotDataQuality,
): ExecutionGate[] {
  const reconciliation = snapshot.operational.reconciliation;
  const reconciliationCurrent = reconciliation.state === "succeeded"
    && reconciliation.generation === snapshot.operational.generation;
  const tape60 = orderFlow.observation?.windows.find((window) => window.window_seconds === 60);
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
    {
      id: "order_flow_trades_60s",
      passed: Boolean(tape60 && tape60.trade_count > 0),
      detail: tape60 ? `trade_count=${tape60.trade_count}` : "no_60s_window",
    },
  ];
}

function newExposureGate(
  snapshot: AccountVenueSnapshot,
  recovery: ExecutionRecoveryStatus,
  tradingMode: "disabled" | "shadow" | "armed",
  quality: SnapshotDataQuality,
  maxContracts: number,
): ExecutionGate {
  const remainingCapacity = Math.max(0, maxContracts - snapshot.totalOpenContracts);
  const failed: string[] = [];
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
    failed.push("flat");
  }
  if (snapshot.openOrders.length > 0) {
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
  orderFlow: ProjectXOrderFlowState,
  now: Date,
): string[] {
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  const gates = armedSafetyGates(snapshot, risk, orderFlow, quality);
  const reasons: string[] = [];
  const stateGate = gates.find((gate) => gate.id === "state_complete");
  if (stateGate && !stateGate.passed) {
    reasons.push(...(stateGate.detail?.split(",") ?? ["venue_state_incomplete"]));
  } else {
    const quoteGate = gates.find((gate) => gate.id === "quote_stale");
    if (quoteGate && !quoteGate.passed) {
      reasons.push("quote_stale");
    }
  }

  for (const gate of gates) {
    if (gate.id === "state_complete" || gate.id === "quote_stale" || gate.passed) {
      continue;
    }
    if (gate.id === "reconciliation_current") {
      reasons.push("reconciliation_not_current");
    } else if (gate.id === "order_flow_trades_60s") {
      reasons.push("order_flow_no_trades_60s");
    }
  }

  return [...new Set(reasons)];
}
