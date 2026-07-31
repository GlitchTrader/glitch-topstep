import type { OrderInfo } from "../domain/models.js";

/** ProjectX terminal order statuses — mirror venue-state applyOrder. */
const TERMINAL_ORDER_STATUSES = new Set([2, 3, 4, 5]);

export function isWorkingOrder(order: OrderInfo): boolean {
  return !TERMINAL_ORDER_STATUSES.has(order.status);
}
