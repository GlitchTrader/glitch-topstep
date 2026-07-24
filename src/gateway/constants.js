export const PACKET_SCHEMA = "glitch.direct.decision_packet.v2";

export const ORDER_SIDE = { 0: "bid", 1: "ask" };
export const ORDER_TYPE = {
  0: "unknown",
  1: "limit",
  2: "market",
  3: "stop_limit",
  4: "stop",
  5: "trailing_stop",
  6: "join_bid",
  7: "join_ask",
};
export const ORDER_STATUS = {
  0: "none",
  1: "open",
  2: "filled",
  3: "cancelled",
  4: "expired",
  5: "rejected",
  6: "pending",
};
export const POSITION_TYPE = { 0: "undefined", 1: "long", 2: "short" };
