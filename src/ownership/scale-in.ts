import type { AccountVenueSnapshot, PositionInfo, TradeAction } from "../domain/models.js";

export type ScaleInAction = "ENTER_LONG" | "ENTER_SHORT";

const PROTECTIVE_TAG_PATTERN = /^glt-.+-(?:r\d+-)?(SL|TP)$/;

export interface ScaleInValidation {
  allowed: boolean;
  reason?: string;
}

function instrumentPosition(
  snapshot: AccountVenueSnapshot,
  contractId: string,
  accountId: number,
): PositionInfo | null {
  return snapshot.positions.find(
    (position) => position.accountId === accountId
      && position.contractId === contractId
      && position.type !== 0
      && Math.abs(position.size) > 0,
  ) ?? null;
}

function expectedPositionType(action: ScaleInAction): 1 | 2 {
  // ponytail: venue-state PnL uses type 1 = long, type 2 = short.
  return action === "ENTER_LONG" ? 1 : 2;
}

export function isProtectiveCustomTag(customTag: string | null | undefined): boolean {
  return typeof customTag === "string" && PROTECTIVE_TAG_PATTERN.test(customTag);
}

export function scaleInActionForPosition(position: PositionInfo): ScaleInAction | null {
  if (position.type === 1) {
    return "ENTER_LONG";
  }
  if (position.type === 2) {
    return "ENTER_SHORT";
  }
  return null;
}

export function validateScaleIn(
  action: ScaleInAction,
  snapshot: AccountVenueSnapshot,
  contractId: string,
  accountId: number,
): ScaleInValidation {
  const position = instrumentPosition(snapshot, contractId, accountId);
  if (!position) {
    return { allowed: false, reason: "no_position" };
  }
  if (position.type !== expectedPositionType(action)) {
    return { allowed: false, reason: "position_side_conflict" };
  }
  const nonProtective = snapshot.openOrders.filter(
    (order) => !isProtectiveCustomTag(order.customTag),
  );
  if (nonProtective.length > 0) {
    return { allowed: false, reason: "working_order_ownership_unresolved" };
  }
  return { allowed: true };
}

export function deriveScaleInSupportedAction(
  snapshot: AccountVenueSnapshot,
  contractId: string,
  accountId: number,
  remainingCapacity: number,
  protectionProven: boolean,
): TradeAction | null {
  if (remainingCapacity <= 0 || !protectionProven || snapshot.instrumentOpenContracts === 0) {
    return null;
  }
  const position = instrumentPosition(snapshot, contractId, accountId);
  if (!position) {
    return null;
  }
  const action = scaleInActionForPosition(position);
  if (!action) {
    return null;
  }
  const scaleIn = validateScaleIn(action, snapshot, contractId, accountId);
  return scaleIn.allowed ? action : null;
}
