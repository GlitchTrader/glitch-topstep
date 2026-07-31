/**
 * Canonical ProjectX hub subscriptions invoked by ProjectXRealtimeService.
 * TS-R2-04 uses this list plus live fixtures to prove each subscription is active.
 */
export const PROJECTX_USER_HUB_SUBSCRIPTIONS = [
  { hub: "user", invoke: "SubscribeAccounts", scope: "global" },
  { hub: "user", invoke: "SubscribeOrders", scope: "account" },
  { hub: "user", invoke: "SubscribePositions", scope: "account" },
  { hub: "user", invoke: "SubscribeTrades", scope: "account" },
] as const;

export const PROJECTX_MARKET_HUB_SUBSCRIPTIONS = [
  { hub: "market", invoke: "SubscribeContractQuotes", scope: "contract" },
  { hub: "market", invoke: "SubscribeContractTrades", scope: "contract" },
  { hub: "market", invoke: "SubscribeContractMarketDepth", scope: "contract" },
] as const;

/** Observed provider_events.event_type values that prove each user subscription. */
export const PROJECTX_USER_STREAM_EVENT_TYPES = [
  "account",
  "order",
  "position",
  "trade",
] as const;

/** Observed provider_events.event_type values that prove each market subscription. */
export const PROJECTX_MARKET_STREAM_EVENT_TYPES = [
  "quote",
  "market_trade",
  "depth",
] as const;

export const PROJECTX_STREAM_CONNECTED_LIFECYCLE_EVENTS = [
  "user_connected_and_subscribed",
  "market_connected_and_subscribed",
] as const;

export interface StreamEventSample {
  event_type: string;
  source: string;
  raw_payload: unknown;
}

export interface StreamSubscriptionProof {
  schema_version: "glitch.projectx.stream_subscriptions_proof.v1";
  captured_utc: string;
  scope: {
    account_id: number;
    account_name: string;
    contract_id: string;
    instrument: string;
  };
  code_subscriptions: {
    user_hub: typeof PROJECTX_USER_HUB_SUBSCRIPTIONS;
    market_hub: typeof PROJECTX_MARKET_HUB_SUBSCRIPTIONS;
  };
  connection_health: {
    user_stream_state: string;
    market_stream_state: string;
    last_user_event_utc: string | null;
    last_market_event_utc: string | null;
    reconciliation_state: string;
    reconciliation_generation: number;
    operational_generation: number;
  };
  observed_event_types: Record<string, string[]>;
  order_flow: {
    trade_count_60s: number | null;
    quote_age_ms: number | null;
  };
  proof_passed: boolean;
  proof_failures: string[];
}

export function buildStreamSubscriptionProof(input: {
  capturedUtc: string;
  scope: StreamSubscriptionProof["scope"];
  health: {
    data_quality?: {
      quote_age_ms?: number;
      operational?: {
        generation?: number;
        userStream?: {
          state?: string;
          lastEventAt?: string | null;
        };
        marketStream?: {
          state?: string;
          lastEventAt?: string | null;
        };
        reconciliation?: {
          state?: string;
          generation?: number;
        };
      };
    };
    order_flow?: {
      observation?: {
        windows?: Array<{ window_seconds: number; trade_count: number }>;
      };
    };
  };
  /** Latest-per event_type corpus, including retained historical user-stream samples. */
  samples: StreamEventSample[];
  /** Current-session evidence only; used to prove live market-hub delivery. */
  liveSamples: StreamEventSample[];
}): StreamSubscriptionProof {
  const operational = input.health.data_quality?.operational;
  const observedBySource = groupObservedEventTypes(input.samples);
  const failures = validateStreamSubscriptionEvidence({
    operational,
    observedBySource,
    samples: input.samples,
    liveSamples: input.liveSamples,
    orderFlowTradeCount60s: tradeCount60s(input.health),
    quoteAgeMs: input.health.data_quality?.quote_age_ms ?? null,
  });

  return {
    schema_version: "glitch.projectx.stream_subscriptions_proof.v1",
    captured_utc: input.capturedUtc,
    scope: input.scope,
    code_subscriptions: {
      user_hub: PROJECTX_USER_HUB_SUBSCRIPTIONS,
      market_hub: PROJECTX_MARKET_HUB_SUBSCRIPTIONS,
    },
    connection_health: {
      user_stream_state: operational?.userStream?.state ?? "unknown",
      market_stream_state: operational?.marketStream?.state ?? "unknown",
      last_user_event_utc: operational?.userStream?.lastEventAt ?? null,
      last_market_event_utc: operational?.marketStream?.lastEventAt ?? null,
      reconciliation_state: operational?.reconciliation?.state ?? "unknown",
      reconciliation_generation: operational?.reconciliation?.generation ?? 0,
      operational_generation: operational?.generation ?? 0,
    },
    observed_event_types: observedBySource,
    order_flow: {
      trade_count_60s: tradeCount60s(input.health),
      quote_age_ms: input.health.data_quality?.quote_age_ms ?? null,
    },
    proof_passed: failures.length === 0,
    proof_failures: failures,
  };
}

export function validateStreamSubscriptionProof(proof: StreamSubscriptionProof): string[] {
  if (proof.schema_version !== "glitch.projectx.stream_subscriptions_proof.v1") {
    return ["schema_version_invalid"];
  }
  if (!proof.proof_passed) {
    return [...proof.proof_failures];
  }
  return validateStreamSubscriptionEvidence({
    operational: {
      generation: proof.connection_health.operational_generation,
      userStream: {
        state: proof.connection_health.user_stream_state,
        lastEventAt: proof.connection_health.last_user_event_utc,
      },
      marketStream: {
        state: proof.connection_health.market_stream_state,
        lastEventAt: proof.connection_health.last_market_event_utc,
      },
      reconciliation: {
        state: proof.connection_health.reconciliation_state,
        generation: proof.connection_health.reconciliation_generation,
      },
    },
    observedBySource: proof.observed_event_types,
    samples: [],
    liveSamples: [],
    orderFlowTradeCount60s: proof.order_flow.trade_count_60s,
    quoteAgeMs: proof.order_flow.quote_age_ms,
    replayFromProof: proof,
  });
}

function validateStreamSubscriptionEvidence(input: {
  operational?: {
    generation?: number;
    userStream?: { state?: string; lastEventAt?: string | null };
    marketStream?: { state?: string; lastEventAt?: string | null };
    reconciliation?: { state?: string; generation?: number };
  };
  observedBySource: Record<string, string[]>;
  samples: StreamEventSample[];
  liveSamples: StreamEventSample[];
  orderFlowTradeCount60s: number | null;
  quoteAgeMs: number | null;
  replayFromProof?: StreamSubscriptionProof;
}): string[] {
  if (input.replayFromProof) {
    return input.replayFromProof.proof_failures;
  }
  const failures: string[] = [];

  if (input.operational?.userStream?.state !== "connected") {
    failures.push("user_stream_not_connected");
  }
  if (input.operational?.marketStream?.state !== "connected") {
    failures.push("market_stream_not_connected");
  }
  if (!input.operational?.marketStream?.lastEventAt) {
    failures.push("market_stream_last_event_missing");
  }
  if (input.operational?.reconciliation?.generation !== input.operational?.generation) {
    failures.push("reconciliation_generation_mismatch");
  }

  for (const lifecycle of PROJECTX_STREAM_CONNECTED_LIFECYCLE_EVENTS) {
    if (!hasObservedEvent(input.observedBySource, "projectx_lifecycle", lifecycle)) {
      failures.push(`lifecycle_missing:${lifecycle}`);
    }
  }

  for (const eventType of PROJECTX_USER_STREAM_EVENT_TYPES) {
    if (!hasObservedPayload(input.samples, "projectx_user_stream", eventType)) {
      failures.push(`user_stream_event_missing:${eventType}`);
    }
  }

  for (const eventType of PROJECTX_MARKET_STREAM_EVENT_TYPES) {
    if (!hasObservedPayload(input.liveSamples, "projectx_market_stream", eventType)) {
      failures.push(`market_stream_event_missing_live:${eventType}`);
    }
  }

  if (input.orderFlowTradeCount60s === null || input.orderFlowTradeCount60s <= 0) {
    failures.push("order_flow_no_trades_60s");
  }
  if (input.quoteAgeMs === null || input.quoteAgeMs > 5_000) {
    failures.push("quote_stale_or_missing");
  }

  return failures;
}

function groupObservedEventTypes(samples: StreamEventSample[]): Record<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const sample of samples) {
    const bucket = grouped.get(sample.source) ?? new Set<string>();
    bucket.add(sample.event_type);
    grouped.set(sample.source, bucket);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, eventTypes]) => [source, [...eventTypes].sort()]),
  );
}

function hasObservedEvent(
  observedBySource: Record<string, string[]>,
  source: string,
  eventType: string,
): boolean {
  return (observedBySource[source] ?? []).includes(eventType);
}

function hasObservedPayload(
  samples: StreamEventSample[],
  source: string,
  eventType: string,
): boolean {
  return samples.some(
    (sample) => sample.source === source
      && sample.event_type === eventType
      && sample.raw_payload !== null
      && sample.raw_payload !== undefined,
  );
}

function tradeCount60s(health: {
  order_flow?: {
    observation?: {
      windows?: Array<{ window_seconds: number; trade_count: number }>;
    };
  };
}): number | null {
  const window = health.order_flow?.observation?.windows?.find(
    (candidate) => candidate.window_seconds === 60,
  );
  return window ? window.trade_count : null;
}
