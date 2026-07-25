import type { ProviderEvidenceEvent } from "../domain/provider-evidence.js";

export interface ProviderEvidenceSink {
  append(event: ProviderEvidenceEvent): unknown;
}

export interface ProviderEventIdentity {
  accountId: number | null;
  contractId: string | null;
  providerEntityId: string | null;
  providerTimestampUtc: string | null;
}

export interface RecordProviderEventInput<T> {
  sink: ProviderEvidenceSink;
  receivedUtc: string;
  source: ProviderEvidenceEvent["source"];
  eventType: string;
  generation: number;
  rawPayload: unknown;
  parse: () => T;
  identity: (value: T) => ProviderEventIdentity;
  apply: (value: T) => void;
}

export function recordProviderEventBeforeApply<T>(
  input: RecordProviderEventInput<T>,
): T {
  const normalized = input.parse();
  const identity = input.identity(normalized);
  input.sink.append({
    receivedUtc: input.receivedUtc,
    providerTimestampUtc: identity.providerTimestampUtc,
    source: input.source,
    eventType: input.eventType,
    generation: input.generation,
    accountId: identity.accountId,
    contractId: identity.contractId,
    providerEntityId: identity.providerEntityId,
    rawPayload: input.rawPayload,
    normalizedPayload: normalized,
  });
  input.apply(normalized);
  return normalized;
}

export function recordProviderLifecycleEvent(
  sink: ProviderEvidenceSink,
  event: Omit<ProviderEvidenceEvent, "source" | "normalizedPayload">,
): void {
  sink.append({
    ...event,
    source: "projectx_lifecycle",
    normalizedPayload: null,
  });
}
