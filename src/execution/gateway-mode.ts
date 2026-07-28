import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { AccountVenueSnapshot, RiskSettings, TradingMode } from "../domain/models.js";
import { evaluateSnapshotDataQuality } from "../state/data-quality.js";

export type EffectiveGatewayMode = "disabled" | "shadow" | "armed" | "degraded_armed";

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

function armedGateReasons(
  snapshot: AccountVenueSnapshot,
  risk: RiskSettings,
  orderFlow: ProjectXOrderFlowState,
  now: Date,
): string[] {
  const reasons: string[] = [];
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  if (!quality.stateComplete) {
    reasons.push(...quality.issues);
  } else if (quality.quoteAgeMs !== null && quality.quoteAgeMs > risk.maxQuoteAgeMs) {
    reasons.push("quote_stale");
  }

  const reconciliation = snapshot.operational.reconciliation;
  if (
    reconciliation.state !== "succeeded"
    || reconciliation.generation !== snapshot.operational.generation
  ) {
    reasons.push("reconciliation_not_current");
  }

  const tape60 = orderFlow.observation?.windows.find((window) => window.window_seconds === 60);
  if (!tape60 || tape60.trade_count <= 0) {
    reasons.push("order_flow_no_trades_60s");
  }

  return [...new Set(reasons)];
}
