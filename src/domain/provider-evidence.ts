export type ProviderEvidenceSource =
  | "projectx_rest"
  | "projectx_user_stream"
  | "projectx_market_stream";

export interface ProviderEvidenceEvent {
  sequence?: number;
  recordedUtc: string;
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
}
