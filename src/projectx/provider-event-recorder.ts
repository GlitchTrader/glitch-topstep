import { createHash } from "node:crypto";
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

export interface RecordRestSnapshotInput {
  receivedUtc: string;
  eventType: string;
  generation: number;
  accountId: number | null;
  contractId: string | null;
  providerEntityId?: string | null;
  normalizedPayload: unknown;
}

export class ProviderRestSnapshotRecorder {
  private readonly lastContentHashByIdentity = new Map<string, string>();

  public constructor(private readonly sink: ProviderEvidenceSink) {}

  public recordIfChanged(input: RecordRestSnapshotInput): boolean {
    const identity = [
      input.eventType,
      input.accountId ?? "",
      input.contractId ?? "",
      input.providerEntityId ?? "",
    ].join("|");
    const contentHash = createHash("sha256")
      .update(stableJson(input.normalizedPayload))
      .digest("hex");
    if (this.lastContentHashByIdentity.get(identity) === contentHash) {
      return false;
    }

    this.sink.append({
      receivedUtc: input.receivedUtc,
      providerTimestampUtc: null,
      source: "projectx_rest",
      eventType: input.eventType,
      generation: input.generation,
      accountId: input.accountId,
      contractId: input.contractId,
      providerEntityId: input.providerEntityId ?? null,
      rawPayload: null,
      normalizedPayload: input.normalizedPayload,
    });
    this.lastContentHashByIdentity.set(identity, contentHash);
    return true;
  }
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

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = stableValue(input[key]);
  }
  return output;
}
