import type { OrderInfo } from "../domain/models.js";

export type ProtectionStatus = "unknown" | "pending" | "proven" | "incomplete";

export interface ProtectionCustomTags {
  entry: string;
  stop: string;
  target: string;
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

const STOP_ORDER_TYPE = 4;
const TARGET_ORDER_TYPE = 1;

export function protectionCustomTags(intentId: string): ProtectionCustomTags {
  const entry = `glt-${intentId}`.slice(0, 64);
  const base = entry.length <= 60 ? entry : entry.slice(0, 60);
  return { entry: base, stop: `${base}-SL`, target: `${base}-TP` };
}

export function intentIdFromStopTag(customTag: string): string | null {
  const match = /^glt-(.+)-SL$/.exec(customTag);
  return match ? match[1]! : null;
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

export function bindProtection(
  intentId: string,
  orders: readonly OrderInfo[],
  accountId: number,
  contractId: string,
  positionOpen: boolean,
  entryOrderId: number | null = null,
): ResolvedProtection {
  const tags = protectionCustomTags(intentId);
  const stop = resolveProtectiveLeg(
    tags.stop,
    STOP_ORDER_TYPE,
    orders,
    accountId,
    contractId,
    entryOrderId,
  );
  const target = resolveProtectiveLeg(
    tags.target,
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

export function latestOrderById(orders: readonly OrderInfo[]): OrderInfo[] {
  const latest = new Map<number, OrderInfo>();
  for (const order of orders) {
    latest.set(order.id, order);
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
