import type { AccountVenueSnapshot } from "../domain/models.js";
import type { TrancheView } from "../ownership/tranches.js";
import { bindProtection } from "../ownership/protection.js";
import { isProtectiveCustomTag } from "../ownership/scale-in.js";
import type { ProtectedReductionRecord } from "./protected-reduction-saga.js";
import {
  partialExitFailClosedEnabled,
  type ProtectedReductionHealth,
} from "./protected-reduction-saga.js";

export interface ProtectionSupervisorInput {
  snapshot: AccountVenueSnapshot;
  tranches: readonly TrancheView[];
  activeReduction: ProtectedReductionRecord | null;
  accountId: number;
  contractId: string;
  nowMs?: number;
}

/** Pure protection coverage evaluation extracted from ExecutionCoordinator. */
export function evaluateProtectionHealth(input: ProtectionSupervisorInput): ProtectedReductionHealth {
  const nowMs = input.nowMs ?? Date.now();
  let unprotected = 0;
  for (const tranche of input.tranches) {
    const protection = bindProtection(
      tranche.intent_id,
      input.snapshot.openOrders,
      input.accountId,
      input.contractId,
      input.snapshot.instrumentOpenContracts > 0,
      tranche.entry_order_id,
    );
    const stopCovered = protection.stop.providerOrderId !== null
      || (input.activeReduction?.state === "degraded_stop_only"
        && input.activeReduction.survivor_stop_order_id !== null);
    if (!stopCovered) {
      unprotected += tranche.remaining_qty;
    }
  }
  const orphans = input.snapshot.instrumentOpenContracts === 0
    ? input.snapshot.openOrders.filter(
      (order) => order.accountId === input.accountId
        && order.contractId === input.contractId
        && isProtectiveCustomTag(order.customTag),
    ).length
    : 0;
  const ambiguousAgeMs = input.activeReduction?.state === "reduction_ambiguous"
    ? Math.max(0, nowMs - Date.parse(input.activeReduction.updated_utc))
    : null;
  return {
    active_state: input.activeReduction?.state ?? null,
    active_reduction_id: input.activeReduction?.reduction_id ?? null,
    unprotected_open_quantity: unprotected,
    orphan_protective_orders: orphans,
    ambiguous_age_ms: ambiguousAgeMs,
    fail_closed_rollback: partialExitFailClosedEnabled(),
  };
}
