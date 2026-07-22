export interface BracketTicks {
  stopTicks: number;
  targetTicks: number;
}

export function isTickAligned(price: number, tickSize: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return false;
  }
  const ticks = price / tickSize;
  return Math.abs(ticks - Math.round(ticks)) < 1e-8;
}

export function calculateBracketTicks(
  side: "long" | "short",
  referencePrice: number,
  stopPrice: number,
  targetPrice: number,
  tickSize: number,
): BracketTicks {
  if (tickSize <= 0) {
    throw new Error("tick_size_invalid");
  }

  const stopDistance = side === "long" ? referencePrice - stopPrice : stopPrice - referencePrice;
  const targetDistance = side === "long" ? targetPrice - referencePrice : referencePrice - targetPrice;
  if (stopDistance <= 0) {
    throw new Error("stop_not_on_loss_side");
  }
  if (targetDistance <= 0) {
    throw new Error("target_not_on_profit_side");
  }

  const stopTicks = Math.ceil(stopDistance / tickSize - 1e-9);
  const targetTicks = Math.floor(targetDistance / tickSize + 1e-9);
  if (stopTicks < 1 || targetTicks < 1) {
    throw new Error("bracket_distance_too_small");
  }

  return { stopTicks, targetTicks };
}
