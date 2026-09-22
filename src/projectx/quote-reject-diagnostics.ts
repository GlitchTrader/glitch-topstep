import { createHash } from "node:crypto";
import { isRecord } from "./schemas.js";

/** Field presence only — never prices, never credentials, never raw payload. */
export type QuoteFieldPresence = "set" | "null" | "miss";

export type QuoteSnapshotKind =
  | "complete_bbo"
  | "partial_bbo"
  | "last_only"
  | "empty"
  | "unknown";

const QUOTE_FIELD_KEYS = [
  "symbol",
  "symbolName",
  "lastPrice",
  "bestBid",
  "bestAsk",
  "change",
  "changePercent",
  "open",
  "high",
  "low",
  "volume",
  "lastUpdated",
  "timestamp",
  "contract",
] as const;

export interface SanitizedQuoteEventDiagnostic {
  event_type: "quote";
  contract_id: string | null;
  instrument_symbol: string | null;
  timestamp: string | null;
  last_updated: string | null;
  /** ProjectX GatewayQuote has no sequence/update id in observed live payloads. */
  sequence_or_update_id: string | null;
  reconnect_generation: number;
  structural_hash: string;
  snapshot_or_partial: QuoteSnapshotKind;
  fields_present: string[];
  fields_absent: string[];
  fields_null: string[];
  bid_presence: QuoteFieldPresence;
  ask_presence: QuoteFieldPresence;
  last_presence: QuoteFieldPresence;
}

export function unwrapQuotePayload(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) {
    return null;
  }
  if (isRecord(input.payload)) {
    return unwrapQuotePayload(input.payload) ?? input.payload;
  }
  if (isRecord(input.data) && ("bestBid" in input.data || "bestAsk" in input.data || "lastPrice" in input.data)) {
    return input.data;
  }
  return input;
}

export function fieldPresence(payload: Record<string, unknown> | null, key: string): QuoteFieldPresence {
  if (!payload || !(key in payload)) {
    return "miss";
  }
  return payload[key] === null ? "null" : "set";
}

export function classifySnapshotKind(
  bid: QuoteFieldPresence,
  ask: QuoteFieldPresence,
  last: QuoteFieldPresence,
): QuoteSnapshotKind {
  const bidOk = bid === "set";
  const askOk = ask === "set";
  const lastOk = last === "set";
  if (bidOk && askOk) {
    return "complete_bbo";
  }
  if (bidOk || askOk) {
    return "partial_bbo";
  }
  if (lastOk) {
    return "last_only";
  }
  if (!bidOk && !askOk && !lastOk) {
    return "empty";
  }
  return "unknown";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sequenceOrUpdateId(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }
  for (const key of Object.keys(payload)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("sequence")
      || lower === "updateid"
      || lower === "update_id"
      || lower === "version"
    ) {
      const value = payload[key];
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
    }
  }
  return null;
}

/** Sanitized reject/ingest diagnostic — structural presence only. */
export function buildSanitizedQuoteEventDiagnostic(input: {
  contractId: string | null;
  payload: unknown;
  reconnectGeneration: number;
}): SanitizedQuoteEventDiagnostic {
  const payload = unwrapQuotePayload(input.payload);
  const present: string[] = [];
  const absent: string[] = [];
  const nulled: string[] = [];
  const presenceMap: Record<string, QuoteFieldPresence> = {};

  for (const key of QUOTE_FIELD_KEYS) {
    const presence = fieldPresence(payload, key);
    presenceMap[key] = presence;
    if (presence === "set") {
      present.push(key);
    } else if (presence === "null") {
      nulled.push(key);
    } else {
      absent.push(key);
    }
  }

  // Include unexpected non-secret keys as names only (no values).
  if (payload) {
    for (const key of Object.keys(payload).sort()) {
      if ((QUOTE_FIELD_KEYS as readonly string[]).includes(key)) {
        continue;
      }
      if (/token|secret|password|authorization|cookie|credential/i.test(key)) {
        continue;
      }
      const presence = fieldPresence(payload, key);
      presenceMap[key] = presence;
      if (presence === "set") {
        present.push(key);
      } else if (presence === "null") {
        nulled.push(key);
      }
    }
  }

  const bid = fieldPresence(payload, "bestBid");
  const ask = fieldPresence(payload, "bestAsk");
  const last = fieldPresence(payload, "lastPrice");
  const structural = JSON.stringify(presenceMap);
  const structuralHash = createHash("sha256").update(structural).digest("hex").slice(0, 16);

  return {
    event_type: "quote",
    contract_id: input.contractId,
    instrument_symbol: stringOrNull(payload?.symbol),
    timestamp: stringOrNull(payload?.timestamp),
    last_updated: stringOrNull(payload?.lastUpdated),
    sequence_or_update_id: sequenceOrUpdateId(payload),
    reconnect_generation: input.reconnectGeneration,
    structural_hash: structuralHash,
    snapshot_or_partial: classifySnapshotKind(bid, ask, last),
    fields_present: present,
    fields_absent: absent,
    fields_null: nulled,
    bid_presence: bid,
    ask_presence: ask,
    last_presence: last,
  };
}
