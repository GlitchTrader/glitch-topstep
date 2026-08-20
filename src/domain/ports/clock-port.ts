/** Injectable clock for domain/execution logic without direct `Date` IO in tests. */
export interface ClockPort {
  nowIso(): string;
  nowMs(): number;
}

export const systemClock: ClockPort = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};
