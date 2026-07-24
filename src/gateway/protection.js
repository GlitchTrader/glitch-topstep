import { ORDER_STATUS, ORDER_TYPE } from "./constants.js";

export function verifyProtection(openOrders, positionState) {
  const working = (openOrders || []).filter(
    (order) => ORDER_STATUS[order.status] === "open" || order.status === 1,
  );
  const stopOrders = working.filter(
    (order) =>
      order.stopPrice != null ||
      ORDER_TYPE[order.type] === "stop" ||
      ORDER_TYPE[order.type] === "trailing_stop",
  );
  const targetOrders = working.filter(
    (order) => order.limitPrice != null && ORDER_TYPE[order.type] === "limit",
  );
  const stopPrice = stopOrders[0]?.stopPrice == null ? null : Number(stopOrders[0].stopPrice);
  const targetPrice =
    targetOrders[0]?.limitPrice == null ? null : Number(targetOrders[0].limitPrice);

  return {
    stop_confirmed: stopOrders.length > 0,
    target_confirmed: targetOrders.length > 0,
    stop_order_id: stopOrders[0]?.id ?? null,
    target_order_id: targetOrders[0]?.id ?? null,
    stop_price: stopPrice,
    target_price: targetPrice,
    move_stop_available:
      positionState?.side !== "flat" && stopOrders.length === 1 && stopPrice != null,
    protection_complete: stopOrders.length > 0 && targetOrders.length > 0,
  };
}
