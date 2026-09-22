/**
 * Controlled-validation gate evaluator (ops / preflight).
 *
 * Replaces the ad-hoc PowerShell gate script that:
 * - counted `@($null).Count` as 1 when `$state.orders` was missing
 * - looked for `packet.market.best_bid/best_ask` instead of official BBO paths
 *
 * Official BBO paths (fail-closed unless one is complete):
 * - `state.quote.bestBid` / `state.quote.bestAsk`
 * - `packet.market.bid` / `packet.market.ask`
 *
 * Open orders: only an explicit `state.openOrders` array is authoritative.
 * Missing / non-array / ambiguous shapes fail closed (`confirmed_empty=false`).
 *
 * user.lastEventAt=null while userStream.state=connected and the account is flat
 * is observed in the field (no user-hub payloads when idle). The stream
 * subscription proof requires market lastEventAt but does not require user
 * lastEventAt for connection health (`src/projectx/stream-subscriptions.ts`).
 * This evaluator still fail-closes on missing/stale user lastEventAt until a
 * separate contract decision explicitly allows flat-idle exemption — do not
 * relax that gate here.
 */

export type OpenOrdersAssessment = {
  confirmed_empty: boolean;
  ambiguous: boolean;
  count: number | null;
  reason: string;
  working_orders: Array<Record<string, unknown>>;
};

export type BboAssessment = {
  complete: boolean;
  stale: boolean;
  ambiguous: boolean;
  bid: number | null;
  ask: number | null;
  source: "state.quote" | "packet.market" | null;
  reason: string;
};

export type StreamEventAssessment = {
  connected: boolean;
  recent_events: boolean;
  last_event_at: string | null;
  age_ms: number | null;
  reason: string;
};

export type ControlledValidationGateInput = {
  health: unknown;
  state: unknown;
  packet?: unknown;
  now_ms?: number;
  /** Max age for stream lastEventAt to count as recent (default 120s). */
  stream_event_max_age_ms?: number;
  /** Max age for quote timestamp to count as fresh BBO (default 6s, matches quote_stale). */
  bbo_max_age_ms?: number;
  packet_budget_ms?: number;
  packet_latency_ms?: number | null;
};

export type ControlledValidationGateResult = {
  schema_version: "glitch.topstep.controlled_validation_gates.v1";
  all_passed: boolean;
  failed_gates: string[];
  open_orders: OpenOrdersAssessment;
  bbo: BboAssessment;
  user_stream: StreamEventAssessment;
  market_stream: StreamEventAssessment;
  gates: Record<string, boolean>;
  notes: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseUtcMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalize only an explicit array. null/undefined/non-array → empty working
 * list with ambiguous=true (never treat missing as a single phantom order).
 */
export function normalizeExplicitArray(value: unknown): {
  items: unknown[];
  present: boolean;
  ambiguous: boolean;
} {
  if (value === undefined || value === null) {
    return { items: [], present: false, ambiguous: true };
  }
  if (!Array.isArray(value)) {
    return { items: [], present: false, ambiguous: true };
  }
  return { items: value, present: true, ambiguous: false };
}

export function assessOpenOrders(state: unknown): OpenOrdersAssessment {
  if (!isRecord(state)) {
    return {
      confirmed_empty: false,
      ambiguous: true,
      count: null,
      reason: "state_not_object",
      working_orders: [],
    };
  }

  // Fail closed if callers still pass the legacy wrong field alone.
  const openOrders = normalizeExplicitArray(state.openOrders);
  if (!openOrders.present) {
    // Do not fall back to `orders` — that field is not the venue-state contract
    // and PowerShell `@($null).Count` previously invented a phantom order.
    return {
      confirmed_empty: false,
      ambiguous: true,
      count: null,
      reason: "openOrders_missing_or_not_array",
      working_orders: [],
    };
  }

  const working = openOrders.items.filter(isRecord);
  if (working.length !== openOrders.items.length) {
    return {
      confirmed_empty: false,
      ambiguous: true,
      count: null,
      reason: "openOrders_contains_non_object_entries",
      working_orders: working,
    };
  }

  return {
    confirmed_empty: working.length === 0,
    ambiguous: false,
    count: working.length,
    reason: working.length === 0 ? "openOrders_empty" : "openOrders_non_empty",
    working_orders: working,
  };
}

function readQuoteBbo(quote: unknown): { bid: number | null; ask: number | null; timestamp: string | null } {
  if (!isRecord(quote)) {
    return { bid: null, ask: null, timestamp: null };
  }
  return {
    bid: asFiniteNumber(quote.bestBid),
    ask: asFiniteNumber(quote.bestAsk),
    timestamp: typeof quote.timestamp === "string" ? quote.timestamp : null,
  };
}

function readPacketMarketBbo(market: unknown): {
  bid: number | null;
  ask: number | null;
  timestamp: string | null;
} {
  if (!isRecord(market)) {
    return { bid: null, ask: null, timestamp: null };
  }
  return {
    bid: asFiniteNumber(market.bid),
    ask: asFiniteNumber(market.ask),
    timestamp: typeof market.quote_timestamp === "string" ? market.quote_timestamp : null,
  };
}

export function assessBbo(
  state: unknown,
  packet: unknown,
  options: { now_ms?: number; max_age_ms?: number; health?: unknown } = {},
): BboAssessment {
  const nowMs = options.now_ms ?? Date.now();
  const maxAgeMs = options.max_age_ms ?? 6_000;

  const stateQuote = isRecord(state) ? readQuoteBbo(state.quote) : { bid: null, ask: null, timestamp: null };
  const packetMarket = isRecord(packet)
    ? readPacketMarketBbo(packet.market)
    : { bid: null, ask: null, timestamp: null };

  let bid: number | null = null;
  let ask: number | null = null;
  let source: BboAssessment["source"] = null;
  let timestamp: string | null = null;

  if (stateQuote.bid !== null && stateQuote.ask !== null) {
    bid = stateQuote.bid;
    ask = stateQuote.ask;
    source = "state.quote";
    timestamp = stateQuote.timestamp;
  } else if (packetMarket.bid !== null && packetMarket.ask !== null) {
    bid = packetMarket.bid;
    ask = packetMarket.ask;
    source = "packet.market";
    timestamp = packetMarket.timestamp;
  }

  if (bid === null || ask === null || source === null) {
    return {
      complete: false,
      stale: false,
      ambiguous: true,
      bid,
      ask,
      source: null,
      reason: "bbo_missing_on_official_paths",
    };
  }

  if (!(ask > bid)) {
    return {
      complete: false,
      stale: false,
      ambiguous: true,
      bid,
      ask,
      source,
      reason: "bbo_geometry_invalid",
    };
  }

  const healthIssues = isRecord(options.health) && isRecord(options.health.data_quality)
    ? options.health.data_quality.issues
    : null;
  const healthSaysStale = Array.isArray(healthIssues) && healthIssues.includes("quote_stale");

  let stale = healthSaysStale;
  const tsMs = parseUtcMs(timestamp);
  if (tsMs !== null) {
    const ageMs = Math.max(0, nowMs - tsMs);
    if (ageMs > maxAgeMs) stale = true;
  } else {
    // Timestamp missing on the chosen source → fail closed as ambiguous/stale.
    stale = true;
  }

  if (stale) {
    return {
      complete: false,
      stale: true,
      ambiguous: false,
      bid,
      ask,
      source,
      reason: healthSaysStale ? "bbo_present_but_quote_stale" : "bbo_present_but_timestamp_stale_or_missing",
    };
  }

  return {
    complete: true,
    stale: false,
    ambiguous: false,
    bid,
    ask,
    source,
    reason: `bbo_complete_from_${source}`,
  };
}

export function assessStreamEvents(
  stream: unknown,
  options: { now_ms?: number; max_age_ms?: number; label: string },
): StreamEventAssessment {
  const nowMs = options.now_ms ?? Date.now();
  const maxAgeMs = options.max_age_ms ?? 120_000;
  if (!isRecord(stream)) {
    return {
      connected: false,
      recent_events: false,
      last_event_at: null,
      age_ms: null,
      reason: `${options.label}_missing`,
    };
  }
  const connected = stream.state === "connected";
  const lastEventAt = typeof stream.lastEventAt === "string" ? stream.lastEventAt : null;
  const eventMs = parseUtcMs(lastEventAt);
  const ageMs = eventMs === null ? null : Math.max(0, nowMs - eventMs);
  const recent = connected && ageMs !== null && ageMs < maxAgeMs;
  let reason = `${options.label}_ok`;
  if (!connected) reason = `${options.label}_not_connected`;
  else if (lastEventAt === null) reason = `${options.label}_lastEventAt_null`;
  else if (ageMs === null) reason = `${options.label}_lastEventAt_unparseable`;
  else if (!recent) reason = `${options.label}_lastEventAt_stale`;
  return {
    connected,
    recent_events: recent,
    last_event_at: lastEventAt,
    age_ms: ageMs,
    reason,
  };
}

export function evaluateControlledValidationGates(
  input: ControlledValidationGateInput,
): ControlledValidationGateResult {
  const nowMs = input.now_ms ?? Date.now();
  const streamMaxAge = input.stream_event_max_age_ms ?? 120_000;
  const bboMaxAge = input.bbo_max_age_ms ?? 6_000;
  const packetBudget = input.packet_budget_ms ?? 20_000;
  const notes: string[] = [
    "user.lastEventAt=null on a flat account is observed and is not treated as automatic pass; gate remains fail-closed until a contract decision allows flat-idle exemption.",
  ];

  const health = input.health;
  const state = input.state;
  const packet = input.packet;

  const openOrders = assessOpenOrders(state);
  const bbo = assessBbo(state, packet, {
    now_ms: nowMs,
    max_age_ms: bboMaxAge,
    health,
  });

  const operational = isRecord(health) && isRecord(health.data_quality)
    ? health.data_quality.operational
    : isRecord(state)
      ? state.operational
      : null;
  const userStream = assessStreamEvents(
    isRecord(operational) ? operational.userStream : null,
    { now_ms: nowMs, max_age_ms: streamMaxAge, label: "user_stream" },
  );
  const marketStream = assessStreamEvents(
    isRecord(operational) ? operational.marketStream : null,
    { now_ms: nowMs, max_age_ms: streamMaxAge, label: "market_stream" },
  );

  const status = isRecord(health) ? health.status : null;
  const tradingMode = isRecord(health) ? health.trading_mode : null;
  const delivery = isRecord(health) ? health.delivery_effective : null;
  const stateComplete = isRecord(health) && isRecord(health.data_quality)
    ? health.data_quality.state_complete === true
    : false;
  const recon = isRecord(operational) ? operational.reconciliation : null;
  const reconOk = isRecord(recon)
    && (recon.state === "succeeded"
      || (typeof recon.lastSucceededAt === "string" && recon.state !== "failed"));
  const positions = isRecord(state) ? normalizeExplicitArray(state.positions) : {
    items: [],
    present: false,
    ambiguous: true,
  };
  const accountFlat = positions.present
    && positions.items.every((item) => {
      if (!isRecord(item)) return false;
      const size = asFiniteNumber(item.size) ?? asFiniteNumber(item.quantity) ?? 0;
      return size === 0;
    });
  const unprotected = isRecord(health) && isRecord(health.protected_reduction)
    ? asFiniteNumber(health.protected_reduction.unprotected_open_quantity)
    : null;
  const cb = isRecord(health) ? health.read_circuit_breaker : null;
  const cbClosed = isRecord(cb)
    && !(isRecord(cb.positions) && cb.positions.open === true)
    && !(isRecord(cb.orders) && cb.orders.open === true);
  const packetOk = input.packet_latency_ms === null || input.packet_latency_ms === undefined
    ? false
    : input.packet_latency_ms <= packetBudget;

  const gates: Record<string, boolean> = {
    status_ready: status === "ok" || status === "ready",
    state_complete: stateComplete,
    trading_mode_shadow: tradingMode === "shadow",
    delivery_disabled: delivery === "disabled",
    open_orders_confirmed_empty: openOrders.confirmed_empty && !openOrders.ambiguous,
    account_flat: positions.present && !positions.ambiguous && accountFlat,
    unprotected_open_quantity_zero: unprotected === 0,
    bbo_complete: bbo.complete && !bbo.stale && !bbo.ambiguous,
    circuit_breaker_closed: cbClosed,
    reconciliation_ok: reconOk,
    user_stream_connected: userStream.connected,
    user_stream_recent_events: userStream.recent_events,
    market_stream_connected: marketStream.connected,
    market_stream_recent_events: marketStream.recent_events,
    no_reconnecting: (() => {
      if (!userStream.connected || !marketStream.connected || !isRecord(operational)) {
        return false;
      }
      const user = operational.userStream;
      const market = operational.marketStream;
      if (!isRecord(user) || !isRecord(market)) return false;
      return user.state !== "reconnecting" && market.state !== "reconnecting";
    })(),
    packet_within_budget: packetOk,
  };

  // Fail closed on ambiguity for orders / BBO / positions.
  if (openOrders.ambiguous) gates.open_orders_confirmed_empty = false;
  if (bbo.ambiguous || bbo.stale) gates.bbo_complete = false;
  if (!positions.present || positions.ambiguous) gates.account_flat = false;

  const failed = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    schema_version: "glitch.topstep.controlled_validation_gates.v1",
    all_passed: failed.length === 0,
    failed_gates: failed,
    open_orders: openOrders,
    bbo,
    user_stream: userStream,
    market_stream: marketStream,
    gates,
    notes,
  };
}
