import type { OrderInfo } from "../domain/models.js";
import { isTerminalOrderStatus } from "../domain/provider-entity-status.js";

export function isWorkingOrder(order: OrderInfo): boolean {
  return !isTerminalOrderStatus(order.status);
}
