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
  relatedProviderEntityId: string | null;
  rawPayload: unknown;
  normalizedPayload: unknown;
}

export interface StoredProviderEvidenceEvent extends ProviderEvidenceEvent {
  sequence: number;
  payloadHash: string;
}

export interface ProviderEvidenceQuery {
  source?: ProviderEvidenceSource;
  eventType?: string;
  accountId?: number;
  contractId?: string;
  providerEntityId?: string;
  relatedProviderEntityId?: string;
  afterSequence?: number;
  limit?: number;
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
