import type { OrderInfo, QuoteInfo } from "../domain/models.js";

export type ProtectionStatus = "unknown" | "pending" | "proven" | "incomplete";

export interface ProtectionCustomTags {
  entry: string;
  stop: string;
  target: string;
  generation: number;
}

export interface ProtectiveLeg {
  customTag: string;
  providerOrderId: number | null;
  price: number | null;
  observedOrder: OrderInfo | null;
}

export interface ResolvedProtection {
  status: ProtectionStatus;
  reason: string;
  stop: ProtectiveLeg;
  target: ProtectiveLeg;
}

export type ProtectiveLegKind = "SL" | "TP";

const STOP_ORDER_TYPE = 4;
const TARGET_ORDER_TYPE = 1;

function protectionTagBase(intentId: string): string {
  // Leave room for `-rNN-SL` / `-rNN-TP` on later re-arm generations.
  const entry = `glt-${intentId}`.slice(0, 64);
  return entry.length <= 56 ? entry : entry.slice(0, 56);
}

export function protectionCustomTags(
  intentId: string,
  generation = 0,
): ProtectionCustomTags {
  const base = protectionTagBase(intentId);
  if (generation <= 0) {
    return { entry: base, stop: `${base}-SL`, target: `${base}-TP`, generation: 0 };
  }
  return {
    entry: base,
    stop: `${base}-r${generation}-SL`,
    target: `${base}-r${generation}-TP`,
    generation,
  };
}

export function parseProtectiveTag(
  customTag: string,
): { intentId: string; leg: ProtectiveLegKind; generation: number } | null {
  const match = /^glt-(.+?)(?:-r(\d+))?-(SL|TP)$/.exec(customTag);
  if (!match) {
    return null;
  }
  return {
    intentId: match[1]!,
    generation: match[2] ? Number(match[2]) : 0,
    leg: match[3] as ProtectiveLegKind,
  };
}

export function intentIdFromStopTag(customTag: string): string | null {
  const parsed = parseProtectiveTag(customTag);
  return parsed?.leg === "SL" ? parsed.intentId : null;
}

export function nextUnusedProtectionGeneration(
  intentId: string,
  orders: readonly OrderInfo[],
  accountId: number,
): number {
  let highest = -1;
  for (const order of orders) {
    if (order.accountId !== accountId || !order.customTag) {
      continue;
    }
    const parsed = parseProtectiveTag(order.customTag);
    if (parsed?.intentId !== intentId) {
      continue;
    }
    highest = Math.max(highest, parsed.generation);
  }
  return highest + 1;
}

/**
 * Find the protective order for one leg of an entry.
 *
 * The venue tags bracket children with the parent's `customTag` plus a `-SL`/`-TP` suffix,
 * which is the primary match. It also sets `parentOrderId` on every child, so brackets the
 * venue creates without our tag (account-level position brackets) are still attributable.
 */
export function resolveProtectiveLeg(
  customTag: string,
  expectedType: number,
  orders: readonly OrderInfo[],
  accountId: number,
  contractId: string,
  entryOrderId: number | null = null,
): ProtectiveLeg {
  const onInstrument = orders.filter(
    (order) => order.accountId === accountId && order.contractId === contractId,
  );
  const tagged = onInstrument.filter((order) => order.customTag === customTag);
  const matches = tagged.length > 0
    ? tagged
    : entryOrderId === null
      ? []
      : onInstrument.filter(
          (order) => order.parentOrderId === entryOrderId && order.type === expectedType,
        );
  if (matches.length !== 1) {
    return { customTag, providerOrderId: null, price: null, observedOrder: null };
  }
  const order = matches[0]!;
  const price = expectedType === STOP_ORDER_TYPE ? order.stopPrice : order.limitPrice;
  return {
    customTag,
    providerOrderId: order.id,
    price,
    observedOrder: order,
  };
}

function resolveIntentProtectiveLeg(
  intentId: string,
  leg: ProtectiveLegKind,
  expectedType: number,
  orders: readonly OrderInfo[],
  accountId: number,
  contractId: string,
  entryOrderId: number | null,
): ProtectiveLeg {
  const onInstrument = orders.filter(
    (order) => order.accountId === accountId && order.contractId === contractId,
  );
  const tagged = onInstrument
    .filter((order) => {
      if (!order.customTag || order.type !== expectedType) {
        return false;
      }
      const parsed = parseProtectiveTag(order.customTag);
      return parsed?.intentId === intentId && parsed.leg === leg;
    })
    .sort((left, right) => {
      const leftGeneration = parseProtectiveTag(left.customTag ?? "")?.generation ?? 0;
      const rightGeneration = parseProtectiveTag(right.customTag ?? "")?.generation ?? 0;
      return rightGeneration - leftGeneration
        || right.updateTimestamp.localeCompare(left.updateTimestamp)
        || right.id - left.id;
    });
  if (tagged.length > 0) {
    const order = tagged[0]!;
    const price = expectedType === STOP_ORDER_TYPE ? order.stopPrice : order.limitPrice;
    return {
      customTag: order.customTag ?? protectionCustomTags(intentId).stop,
      providerOrderId: order.id,
      price,
      observedOrder: order,
    };
  }
  return resolveProtectiveLeg(
    protectionCustomTags(intentId)[leg === "SL" ? "stop" : "target"],
    expectedType,
    orders,
    accountId,
    contractId,
    entryOrderId,
  );
}

export function bindProtection(
  intentId: string,
  orders: readonly OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
  entryOrderId: number | null = null,
): ResolvedProtection {
  const stop = resolveIntentProtectiveLeg(
    intentId,
    "SL",
    STOP_ORDER_TYPE,
    orders,
    accountId,
    contractId,
    entryOrderId,
  );
  const target = resolveIntentProtectiveLeg(
    intentId,
    "TP",
    TARGET_ORDER_TYPE,
    orders,
    accountId,
    contractId,
    entryOrderId,
  );

  if (!positionOpen) {
    return {
      status: "unknown",
      reason: "no_open_position",
      stop,
      target,
    };
  }

  const issues: string[] = [];
  if (!stop.providerOrderId) {
    issues.push("stop_child_not_observed");
  } else if (stop.observedOrder?.type !== STOP_ORDER_TYPE) {
    issues.push("stop_type_mismatch");
  }
  if (!target.providerOrderId) {
    issues.push("target_child_not_observed");
  } else if (target.observedOrder?.type !== TARGET_ORDER_TYPE) {
    issues.push("target_type_mismatch");
  }

  if (issues.length > 0) {
    return {
      status: "pending",
      reason: issues.join(";"),
      stop,
      target,
    };
  }

  return {
    status: "proven",
    reason: "provider_child_orders_bound_by_custom_tag",
    stop,
    target,
  };
}

/**
 * Price the venue last held for a protective leg, cancelled orders included.
 *
 * MOVE_STOP edits the working order in place, so the intent registered when the tranche opened
 * still carries the original price. Re-placing a leg from that payload would silently widen a
 * stop the operator had already tightened, so the newest order carrying the leg's tag wins and
 * the intent is only a fallback for a leg the venue never accepted.
 */
export function lastProtectivePrice(
  orders: readonly OrderInfo[],
  customTag: string,
  expectedType: number,
  accountId: number,
  contractId: string,
): number | null {
  const legs = orders
    .filter((order) => order.accountId === accountId
      && order.contractId === contractId
      && order.customTag === customTag
      && order.type === expectedType)
    .sort((left, right) => left.updateTimestamp.localeCompare(right.updateTimestamp)
      || left.id - right.id);
  const latest = legs.at(-1);
  if (!latest) {
    return null;
  }
  return expectedType === STOP_ORDER_TYPE ? latest.stopPrice : latest.limitPrice;
}

export function lastProtectivePriceForIntent(
  orders: readonly OrderInfo[],
  intentId: string,
  leg: ProtectiveLegKind,
  expectedType: number,
  accountId: number,
  contractId: string,
): number | null {
  const legs = orders
    .filter((order) => {
      if (
        order.accountId !== accountId
        || order.contractId !== contractId
        || order.type !== expectedType
        || !order.customTag
      ) {
        return false;
      }
      const parsed = parseProtectiveTag(order.customTag);
      return parsed?.intentId === intentId && parsed.leg === leg;
    })
    .sort((left, right) => left.updateTimestamp.localeCompare(right.updateTimestamp)
      || left.id - right.id);
  const latest = legs.at(-1);
  if (!latest) {
    return null;
  }
  return expectedType === STOP_ORDER_TYPE ? latest.stopPrice : latest.limitPrice;
}

/**
 * Keep a re-armed bracket on the non-marketable side of the live quote.
 *
 * Auto OCO cancel + re-arm can race a live swing: the historical stop is still the right
 * distance, but the market has already traded through it. Re-placing that price would cover
 * the position immediately instead of protecting it.
 */
export function sanitizeRearmProtectionPrices(
  coverSide: 0 | 1,
  stopPrice: number,
  targetPrice: number,
  quote: QuoteInfo | null,
  tickSize: number,
): { stopPrice: number; targetPrice: number; adjusted: boolean } {
  const mark = coverSide === 0
    ? Math.max(quote?.bestAsk ?? Number.NEGATIVE_INFINITY, quote?.lastPrice ?? Number.NEGATIVE_INFINITY)
    : Math.min(quote?.bestBid ?? Number.POSITIVE_INFINITY, quote?.lastPrice ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(mark) || !(tickSize > 0)) {
    return { stopPrice, targetPrice, adjusted: false };
  }
  const width = Math.max(Math.abs(stopPrice - targetPrice), tickSize * 4);
  let nextStop = stopPrice;
  let nextTarget = targetPrice;
  if (coverSide === 0) {
    if (nextStop <= mark) {
      nextStop = mark + width;
    }
    if (nextTarget >= mark) {
      nextTarget = mark - width;
    }
    if (nextTarget >= nextStop) {
      nextTarget = nextStop - width;
    }
  } else {
    if (nextStop >= mark) {
      nextStop = mark - width;
    }
    if (nextTarget <= mark) {
      nextTarget = mark + width;
    }
    if (nextTarget <= nextStop) {
      nextTarget = nextStop + width;
    }
  }
  return {
    stopPrice: nextStop,
    targetPrice: nextTarget,
    adjusted: nextStop !== stopPrice || nextTarget !== targetPrice,
  };
}

export function latestOrderById(orders: readonly OrderInfo[]): OrderInfo[] {
  const latest = new Map<number, OrderInfo>();
  for (const order of orders) {
    const previous = latest.get(order.id);
    if (!previous) {
      latest.set(order.id, order);
      continue;
    }
    const previousTs = previous.updateTimestamp || previous.creationTimestamp || "";
    const nextTs = order.updateTimestamp || order.creationTimestamp || "";
    if (nextTs.localeCompare(previousTs) >= 0) {
      latest.set(order.id, order);
    }
  }
  return [...latest.values()];
}

export function aggregateProtectionStatus(
  entries: Array<{ protection: { status: ProtectionStatus } }>,
  positionOpen: boolean,
): ProtectionStatus {
  if (!positionOpen) {
    return "unknown";
  }
  if (entries.length === 0) {
    return "pending";
  }
  if (entries.some((entry) => entry.protection.status === "incomplete")) {
    return "incomplete";
  }
  if (entries.every((entry) => entry.protection.status === "proven")) {
    return "proven";
  }
  return "pending";
}
