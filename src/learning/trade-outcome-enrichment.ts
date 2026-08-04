import type { TradeInfo } from "../domain/models.js";
import type { TrancheView } from "../ownership/tranches.js";
import type {
  TradeOutcomeExitReason,
  TradeOutcomeFill,
} from "./trade-outcome.js";
import type { TradeOutcomeFlatTrigger } from "./trade-outcome-flat.js";

export function toOutcomeFills(trades: readonly TradeInfo[]): TradeOutcomeFill[] {
  return [...trades]
    .sort((left, right) => left.creationTimestamp.localeCompare(right.creationTimestamp))
    .map((trade) => ({
      price: trade.price,
      size: trade.size,
      side: trade.side,
      order_id: trade.orderId,
      timestamp: trade.creationTimestamp,
      profit_and_loss: trade.profitAndLoss,
      fees: trade.fees,
    }));
}

export function inferSideFromFills(
  trades: readonly TradeInfo[],
  entryOrderId: number | null,
): "long" | "short" | null {
  const entry = entryOrderId === null
    ? trades[0]
    : trades.find((trade) => trade.orderId === entryOrderId) ?? trades[0];
  if (!entry) {
    return null;
  }
  // ProjectX: side 0 = bid/buy, 1 = ask/sell for TradeInfo.
  return entry.side === 0 ? "long" : entry.side === 1 ? "short" : null;
}

export function entryAndExitPrices(
  trades: readonly TradeInfo[],
  entryOrderId: number | null,
): { entry_price: number | null; exit_price: number | null } {
  const ordered = [...trades].sort(
    (left, right) => left.creationTimestamp.localeCompare(right.creationTimestamp),
  );
  const entry = entryOrderId === null
    ? ordered[0]
    : ordered.find((trade) => trade.orderId === entryOrderId) ?? ordered[0];
  const closing = [...ordered].reverse().find((trade) => trade.profitAndLoss !== null)
    ?? ordered.at(-1);
  return {
    entry_price: entry?.price ?? null,
    exit_price: closing && closing !== entry ? closing.price : (closing?.price ?? null),
  };
}

export function inferExitReason(input: {
  closingOrderId: number | null;
  stopOrderId: number | null;
  targetOrderId: number | null;
  entryOrderId: number | null;
  trigger: TradeOutcomeFlatTrigger;
  hadExitIntent: boolean;
}): TradeOutcomeExitReason {
  if (input.closingOrderId !== null && input.stopOrderId !== null
    && input.closingOrderId === input.stopOrderId) {
    return "stop_loss";
  }
  if (input.closingOrderId !== null && input.targetOrderId !== null
    && input.closingOrderId === input.targetOrderId) {
    return "take_profit";
  }
  if (input.hadExitIntent) {
    return "manual_exit";
  }
  if (input.trigger === "reconcile" && input.closingOrderId === null) {
    return "reconciliation";
  }
  return "unknown";
}

export function structuralRiskUsd(input: {
  side: "long" | "short" | null;
  entryPrice: number | null;
  stopPrice: number | null;
  quantity: number;
  tickSize: number;
  tickValue: number;
}): number | null {
  if (
    input.side === null
    || input.entryPrice === null
    || input.stopPrice === null
    || input.quantity <= 0
    || !(input.tickSize > 0)
    || !(input.tickValue > 0)
  ) {
    return null;
  }
  const points = input.side === "long"
    ? input.entryPrice - input.stopPrice
    : input.stopPrice - input.entryPrice;
  if (!(points > 0)) {
    return null;
  }
  const pointValue = input.tickValue / input.tickSize;
  return roundUsd(points * pointValue * input.quantity);
}

export function rMultiple(realizedPnlUsd: number, initialRiskUsd: number | null): number | null {
  if (initialRiskUsd === null || !(initialRiskUsd > 0)) {
    return null;
  }
  return Math.round((realizedPnlUsd / initialRiskUsd) * 1000) / 1000;
}

export function ticksFromUsd(
  usd: number | null,
  quantity: number,
  tickValue: number,
): number | null {
  if (usd === null || !(quantity > 0) || !(tickValue > 0)) {
    return null;
  }
  return Math.round((usd / (tickValue * quantity)) * 100) / 100;
}

export function stopTargetFromTranche(tranche: TrancheView): {
  stop_price: number | null;
  target_price: number | null;
} {
  return {
    stop_price: tranche.protection.stop.price,
    target_price: tranche.protection.target.price,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
