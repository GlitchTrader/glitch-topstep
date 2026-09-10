import type { QuoteInfo } from "../domain/models.js";
import { isRecord } from "./schemas.js";
import {
  buildSanitizedQuoteEventDiagnostic,
  type SanitizedQuoteEventDiagnostic,
  unwrapQuotePayload,
} from "./quote-reject-diagnostics.js";

/** Bounded side TTL — aligns with typical maxQuoteAgeMs; prevents merging stale opposite sides. */
export const DEFAULT_QUOTE_BBO_SIDE_TTL_MS = 5_000;

/** Max contracts retained (subscribed universe is small; hard cap for safety). */
export const DEFAULT_QUOTE_BBO_ASSEMBLER_MAX_CONTRACTS = 32;

export type QuoteAssembleStatus =
  | "ready"
  | "locked"
  | "crossed"
  | "incomplete"
  | "stale"
  | "cleared";

export interface QuoteAssembleResult {
  status: QuoteAssembleStatus;
  quote: QuoteInfo | null;
  diagnostic: SanitizedQuoteEventDiagnostic;
  reason: string;
  /** True when assembler retained dual-side state after this event. */
  state_complete: boolean;
}

interface SideState {
  price: number;
  providerTsMs: number;
  receivedMs: number;
}

interface ContractAssembleState {
  contractId: string;
  generation: number;
  symbol: string;
  symbolName?: string;
  bid: SideState | null;
  ask: SideState | null;
  lastPrice: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function providerTimestampMs(payload: Record<string, unknown>): number | null {
  const raw = typeof payload.lastUpdated === "string" && payload.lastUpdated.length > 0
    ? payload.lastUpdated
    : typeof payload.timestamp === "string"
      ? payload.timestamp
      : null;
  if (!raw) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function providerTimestampUtc(payload: Record<string, unknown>, fallbackIso: string): string {
  if (typeof payload.lastUpdated === "string" && payload.lastUpdated.length > 0) {
    return payload.lastUpdated;
  }
  if (typeof payload.timestamp === "string" && payload.timestamp.length > 0) {
    return payload.timestamp;
  }
  return fallbackIso;
}

/**
 * Explicit per-contract BBO delta assembler for ProjectX GatewayQuote.
 * Provenance: same contract + reconnect generation + TTL + non-regressing provider timestamps.
 * Never fabricates bid/ask from last.
 */
export class QuoteBboAssembler {
  private readonly states = new Map<string, ContractAssembleState>();
  private activeGeneration: number | null = null;

  constructor(
    private readonly sideTtlMs: number = DEFAULT_QUOTE_BBO_SIDE_TTL_MS,
    private readonly maxContracts: number = DEFAULT_QUOTE_BBO_ASSEMBLER_MAX_CONTRACTS,
  ) {}

  size(): number {
    return this.states.size;
  }

  clearAll(reason = "manual_clear"): void {
    this.states.clear();
    void reason;
  }

  clearContract(contractId: string): void {
    this.states.delete(contractId);
  }

  /** Drop all assembled sides when operational generation advances (reconnect/stream gap). */
  onReconnectGeneration(generation: number): void {
    if (this.activeGeneration !== null && this.activeGeneration !== generation) {
      this.states.clear();
    }
    this.activeGeneration = generation;
  }

  ingest(input: {
    contractId: string;
    payload: unknown;
    reconnectGeneration: number;
    receivedMs: number;
    receivedUtc?: string;
  }): QuoteAssembleResult {
    this.onReconnectGeneration(input.reconnectGeneration);
    const diagnostic = buildSanitizedQuoteEventDiagnostic({
      contractId: input.contractId,
      payload: input.payload,
      reconnectGeneration: input.reconnectGeneration,
    });
    const receivedUtc = input.receivedUtc ?? new Date(input.receivedMs).toISOString();
    const payload = unwrapQuotePayload(input.payload);
    if (!payload) {
      this.clearContract(input.contractId);
      return {
        status: "incomplete",
        quote: null,
        diagnostic,
        reason: "quote_not_object",
        state_complete: false,
      };
    }

    let state = this.states.get(input.contractId);
    if (state && state.generation !== input.reconnectGeneration) {
      this.clearContract(input.contractId);
      state = undefined;
    }

    const providerTsMs = providerTimestampMs(payload);
    if (providerTsMs === null) {
      return {
        status: "incomplete",
        quote: null,
        diagnostic,
        reason: "quote_timestamp_missing",
        state_complete: false,
      };
    }

    // Timestamp regression vs retained sides => sequence-gap proxy (provider has no seq id).
    if (state) {
      const prior = Math.max(
        state.bid?.providerTsMs ?? Number.NEGATIVE_INFINITY,
        state.ask?.providerTsMs ?? Number.NEGATIVE_INFINITY,
      );
      if (Number.isFinite(prior) && providerTsMs + 1 < prior) {
        this.clearContract(input.contractId);
        return {
          status: "cleared",
          quote: null,
          diagnostic,
          reason: "timestamp_regression",
          state_complete: false,
        };
      }
    }

    if (!state) {
      state = {
        contractId: input.contractId,
        generation: input.reconnectGeneration,
        symbol: typeof payload.symbol === "string" ? payload.symbol : input.contractId,
        ...(typeof payload.symbolName === "string" ? { symbolName: payload.symbolName } : {}),
        bid: null,
        ask: null,
        lastPrice: null,
        open: null,
        high: null,
        low: null,
        volume: null,
      };
      this.remember(input.contractId, state);
    } else if (typeof payload.symbol === "string") {
      state.symbol = payload.symbol;
      if (typeof payload.symbolName === "string") {
        state.symbolName = payload.symbolName;
      }
    }

    const bid = nullableFiniteNumber(payload.bestBid);
    const ask = nullableFiniteNumber(payload.bestAsk);
    const last = nullableFiniteNumber(payload.lastPrice);
    // Never promote last into bid/ask.
    if (bid !== null) {
      state.bid = { price: bid, providerTsMs, receivedMs: input.receivedMs };
    }
    if (ask !== null) {
      state.ask = { price: ask, providerTsMs, receivedMs: input.receivedMs };
    }
    if (last !== null) {
      state.lastPrice = last;
    }
    const open = nullableFiniteNumber(payload.open);
    const high = nullableFiniteNumber(payload.high);
    const low = nullableFiniteNumber(payload.low);
    const volume = nullableFiniteNumber(payload.volume);
    if (open !== null) state.open = open;
    if (high !== null) state.high = high;
    if (low !== null) state.low = low;
    if (volume !== null) state.volume = volume;

    this.expireStaleSides(state, input.receivedMs);

    if (state.bid === null || state.ask === null) {
      return {
        status: "incomplete",
        quote: null,
        diagnostic,
        reason: "quote_bbo_incomplete",
        state_complete: false,
      };
    }

    const bestBid = state.bid.price;
    const bestAsk = state.ask.price;
    const resolvedLast = state.lastPrice ?? (bestBid + bestAsk) / 2;
    const quote: QuoteInfo = {
      contractId: input.contractId,
      symbol: state.symbol,
      ...(state.symbolName ? { symbolName: state.symbolName } : {}),
      lastPrice: resolvedLast,
      bestBid,
      bestAsk,
      open: state.open ?? resolvedLast,
      high: state.high ?? resolvedLast,
      low: state.low ?? resolvedLast,
      volume: state.volume ?? 0,
      timestamp: providerTimestampUtc(payload, receivedUtc),
    };

    if (!(bestBid < bestAsk)) {
      if (bestBid === bestAsk) {
        return {
          status: "locked",
          quote,
          diagnostic,
          reason: "locked_bbo",
          state_complete: true,
        };
      }
      return {
        status: "crossed",
        quote,
        diagnostic,
        reason: "crossed_bbo",
        state_complete: true,
      };
    }

    return {
      status: "ready",
      quote,
      diagnostic,
      reason: "assembled_bbo",
      state_complete: true,
    };
  }

  private expireStaleSides(state: ContractAssembleState, receivedMs: number): void {
    if (state.bid && receivedMs - state.bid.receivedMs > this.sideTtlMs) {
      state.bid = null;
    }
    if (state.ask && receivedMs - state.ask.receivedMs > this.sideTtlMs) {
      state.ask = null;
    }
  }

  private remember(contractId: string, state: ContractAssembleState): void {
    if (this.states.has(contractId)) {
      this.states.delete(contractId);
    }
    this.states.set(contractId, state);
    while (this.states.size > this.maxContracts) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.states.delete(oldest);
    }
  }
}

/** Helper for tests / offline replay of recorded envelopes. */
export function ingestGatewayQuoteEnvelope(
  assembler: QuoteBboAssembler,
  envelope: { contractId: string; payload: unknown },
  reconnectGeneration: number,
  receivedMs: number,
): QuoteAssembleResult {
  if (!isRecord(envelope) || typeof envelope.contractId !== "string") {
    throw new Error("quote_envelope_invalid");
  }
  return assembler.ingest({
    contractId: envelope.contractId,
    payload: envelope.payload,
    reconnectGeneration,
    receivedMs,
  });
}
