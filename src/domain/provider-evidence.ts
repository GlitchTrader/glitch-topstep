export type ProviderEvidenceSource =
  | "projectx_rest"
  | "projectx_user_stream"
  | "projectx_market_stream"
  | "projectx_lifecycle";

export interface ProviderEvidenceEvent {
  receivedUtc: string;
  providerTimestampUtc: string | null;
  source: ProviderEvidenceSource;
  eventType: string;
  generation: number;
  accountId: number | null;
  contractId: string | null;
  providerEntityId: string | null;
  rawPayload: unknown;
  normalizedPayload: unknown;
}

export interface StoredProviderEvidenceEvent extends ProviderEvidenceEvent {
  sequence: number;
  payloadHash: string;
}

export interface ProviderEvidenceStatus {
  eventCount: number;
  marketEventCount: number;
  earliestSequence: number | null;
  latestSequence: number | null;
  latestReceivedUtc: string | null;
  marketEventRetention: number;
  marketPruneInterval: number;
  maximumMarketEventsBetweenPrunes: number;
}
