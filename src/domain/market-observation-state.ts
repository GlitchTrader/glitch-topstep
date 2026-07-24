import type { MultiTimeframeObservation } from "./market-observation.js";

export interface MarketObservationState {
  lastAttemptUtc: string | null;
  lastSucceededUtc: string | null;
  lastError: string | null;
  observation: MultiTimeframeObservation | null;
}
