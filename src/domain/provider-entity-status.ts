/** ProjectX order statuses that are no longer working (filled / cancelled / expired / rejected). */
export const TERMINAL_ORDER_STATUSES = [2, 3, 4, 5] as const;

export type TerminalOrderStatus = (typeof TERMINAL_ORDER_STATUSES)[number];

export function isTerminalOrderStatus(status: number): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly number[]).includes(status);
}

/** Flat or void venue position — type 0 or size 0. */
export function isFlatPosition(position: { type: number; size: number }): boolean {
  return position.type === 0 || position.size === 0;
}
