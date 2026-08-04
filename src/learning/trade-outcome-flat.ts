import type { PositionInfo } from "../domain/models.js";
import { sumInstrumentNetContracts } from "../state/venue-state.js";
import type { TrancheView } from "../ownership/tranches.js";

export type TradeOutcomeFlatTrigger = "reconcile" | "stream";

export function projectedInstrumentOpenContracts(
  positions: readonly PositionInfo[],
  accountId: number,
  contractId: string,
  incoming: PositionInfo,
): number {
  const scoped = positions.filter((position) => position.accountId === accountId);
  const withoutIncoming = scoped.filter((position) => position.id !== incoming.id);
  const next = [...withoutIncoming];
  if (incoming.size !== 0 && incoming.type !== 0) {
    next.push(incoming);
  }
  return sumInstrumentNetContracts(next, contractId);
}

export function tranchesForClosedPosition(tranches: readonly TrancheView[]): TrancheView[] {
  const active = tranches.filter((tranche) => tranche.remaining_qty > 0);
  if (active.length > 0) {
    return [...active];
  }
  return tranches.filter((tranche) => tranche.filled_qty > 0);
}

export function shouldPublishTradeOutcomesOnFlat(input: {
  beforeOpen: number;
  afterOpen: number;
  lastReconciledOpenContracts: number;
  tranches: readonly TrancheView[];
}): boolean {
  if (input.afterOpen !== 0 || input.tranches.length === 0) {
    return false;
  }
  return input.beforeOpen > 0 || input.lastReconciledOpenContracts > 0;
}
