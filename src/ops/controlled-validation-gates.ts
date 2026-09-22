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
 * BBO freshness uses capture-time evidence only:
 * - prefer `health.data_quality.quote_age_ms` from the capture
 * - else `quote.timestamp` / `quote_timestamp` vs the capture clock
 *   (`capture_now_ms`, `now_ms`, `health.recorded_utc`, or `state.capturedAt`)
 * - never `Date.now()` against a frozen JSON artifact
 *
 * User stream event requirement:
 * - `recent_events` when `userStream.lastEventAt` is fresh on the capture clock, or
 * - `flat_idle_user_stream` when lastEventAt is null/stale BUT the account is flat,
 *   openOrders=[], reconciliation current/fresh (both generations present, valid,
 *   and equal), user connected, market recent, and BBO fresh — otherwise fail closed.
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
  age_ms: number | null;
  age_source: "quote_age_ms" | "timestamp_vs_capture" | null;
};

export type StreamEventAssessment = {
  connected: boolean;
  recent_events: boolean;
  last_event_at: string | null;
  age_ms: number | null;
  reason: string;
};

export type UserStreamMode = "recent_events" | "flat_idle_user_stream" | "insufficient";

export type FlatIdleUserStreamAssessment = {
  eligible: boolean;
  reason: string;
};

export type CaptureClock = {
  ms: number;
  source: "capture_now_ms" | "now_ms" | "health.recorded_utc" | "state.capturedAt";
};

export type ControlledValidationGateInput = {
  health: unknown;
  state: unknown;
  packet?: unknown;
  /**
   * Capture clock (ms since epoch). Preferred explicit override.
   * Do not pass wall-clock when evaluating frozen evidence JSON.
   */
  capture_now_ms?: number;
  /** Alias for capture clock (legacy). Same semantics as `capture_now_ms`. */
  now_ms?: number;
  /** Max age for stream lastEventAt to count as recent (default 120s). */
  stream_event_max_age_ms?: number;
  /** Max age for quote to count as fresh BBO (default 6s, matches quote_stale). */
  bbo_max_age_ms?: number;
  /** Max age for reconciliation lastSucceededAt under flat-idle (default = stream max). */
  reconciliation_max_age_ms?: number;
  packet_budget_ms?: number;
  packet_latency_ms?: number | null;
};

export type ControlledValidationGateResult = {
  schema_version: "glitch.topstep.controlled_validation_gates.v2";
  all_passed: boolean;
  failed_gates: string[];
  open_orders: OpenOrdersAssessment;
  bbo: BboAssessment;
  user_stream: StreamEventAssessment;
  market_stream: StreamEventAssessment;
  user_stream_mode: UserStreamMode;
  flat_idle_user_stream: FlatIdleUserStreamAssessment;
  capture_clock: CaptureClock | null;
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

/** Operational / reconciliation generation: non-negative integer only. Missing → null (fail closed). */
function asGeneration(value: unknown): number | null {
  const n = asFiniteNumber(value);
  if (n === null || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseUtcMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveCaptureClock(
  health: unknown,
  state: unknown,
  options: { capture_now_ms?: number; now_ms?: number } = {},
): CaptureClock | null {
  if (typeof options.capture_now_ms === "number" && Number.isFinite(options.capture_now_ms)) {
    return { ms: options.capture_now_ms, source: "capture_now_ms" };
  }
  if (typeof options.now_ms === "number" && Number.isFinite(options.now_ms)) {
    return { ms: options.now_ms, source: "now_ms" };
  }
  if (isRecord(health)) {
    const recorded = parseUtcMs(health.recorded_utc);
    if (recorded !== null) return { ms: recorded, source: "health.recorded_utc" };
  }
  if (isRecord(state)) {
    const captured = parseUtcMs(state.capturedAt);
    if (captured !== null) return { ms: captured, source: "state.capturedAt" };
  }
  return null;
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
  options: {
    capture_now_ms?: number | null;
    max_age_ms?: number;
    health?: unknown;
  } = {},
): BboAssessment {
  const maxAgeMs = options.max_age_ms ?? 6_000;
  const captureNowMs = options.capture_now_ms ?? null;

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
      age_ms: null,
      age_source: null,
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
      age_ms: null,
      age_source: null,
    };
  }

  const healthIssues = isRecord(options.health) && isRecord(options.health.data_quality)
    ? options.health.data_quality.issues
    : null;
  const healthSaysStale = Array.isArray(healthIssues) && healthIssues.includes("quote_stale");

  const quoteAgeFromHealth = isRecord(options.health) && isRecord(options.health.data_quality)
    ? asFiniteNumber(options.health.data_quality.quote_age_ms)
    : null;

  let ageMs: number | null = null;
  let ageSource: BboAssessment["age_source"] = null;
  if (quoteAgeFromHealth !== null && quoteAgeFromHealth >= 0) {
    ageMs = quoteAgeFromHealth;
    ageSource = "quote_age_ms";
  } else {
    const tsMs = parseUtcMs(timestamp);
    if (tsMs !== null && captureNowMs !== null) {
      ageMs = Math.max(0, captureNowMs - tsMs);
      ageSource = "timestamp_vs_capture";
    }
  }

  let stale = healthSaysStale;
  let reasonComplete = `bbo_complete_from_${source}`;
  if (ageMs === null || ageSource === null) {
    stale = true;
    return {
      complete: false,
      stale: true,
      ambiguous: false,
      bid,
      ask,
      source,
      reason: "bbo_capture_age_unavailable",
      age_ms: null,
      age_source: null,
    };
  }
  if (ageMs > maxAgeMs) stale = true;

  if (stale) {
    return {
      complete: false,
      stale: true,
      ambiguous: false,
      bid,
      ask,
      source,
      reason: healthSaysStale ? "bbo_present_but_quote_stale" : "bbo_present_but_timestamp_stale_or_missing",
      age_ms: ageMs,
      age_source: ageSource,
    };
  }

  return {
    complete: true,
    stale: false,
    ambiguous: false,
    bid,
    ask,
    source,
    reason: reasonComplete,
    age_ms: ageMs,
    age_source: ageSource,
  };
}

export function assessStreamEvents(
  stream: unknown,
  options: { capture_now_ms?: number | null; max_age_ms?: number; label: string },
): StreamEventAssessment {
  const captureNowMs = options.capture_now_ms ?? null;
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
  const ageMs = eventMs === null || captureNowMs === null
    ? null
    : Math.max(0, captureNowMs - eventMs);
  const recent = connected && ageMs !== null && ageMs < maxAgeMs;
  let reason = `${options.label}_ok`;
  if (!connected) reason = `${options.label}_not_connected`;
  else if (lastEventAt === null) reason = `${options.label}_lastEventAt_null`;
  else if (captureNowMs === null) reason = `${options.label}_capture_clock_missing`;
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

function healthIssueList(health: unknown): string[] {
  if (!isRecord(health) || !isRecord(health.data_quality)) return [];
  const issues = health.data_quality.issues;
  return Array.isArray(issues) ? issues.filter((item): item is string => typeof item === "string") : [];
}

function accountIsFlat(state: unknown): { flat: boolean; present: boolean; ambiguous: boolean } {
  if (!isRecord(state)) {
    return { flat: false, present: false, ambiguous: true };
  }
  const positions = normalizeExplicitArray(state.positions);
  if (!positions.present || positions.ambiguous) {
    return { flat: false, present: positions.present, ambiguous: true };
  }
  const flat = positions.items.every((item) => {
    if (!isRecord(item)) return false;
    const size = asFiniteNumber(item.size) ?? asFiniteNumber(item.quantity) ?? 0;
    return size === 0;
  });
  return { flat, present: true, ambiguous: false };
}

/**
 * Fail-closed reconciliation freshness for controlled validation / flat-idle.
 * Both `operational.generation` and `reconciliation.generation` must be present,
 * non-negative integers, and equal — missing or invalid generations never pass.
 */
export function reconciliationFresh(
  operational: unknown,
  health: unknown,
  captureNowMs: number | null,
  maxAgeMs: number,
): { ok: boolean; reason: string } {
  if (!isRecord(operational)) {
    return { ok: false, reason: "operational_missing" };
  }
  const recon = operational.reconciliation;
  if (!isRecord(recon)) {
    return { ok: false, reason: "reconciliation_missing" };
  }
  if (recon.state === "running" || recon.state === "failed") {
    return { ok: false, reason: `reconciliation_${String(recon.state)}` };
  }
  if (recon.state !== "succeeded") {
    return { ok: false, reason: "reconciliation_not_succeeded" };
  }

  const issues = healthIssueList(health);
  if (issues.includes("reconciliation_not_current")) {
    return { ok: false, reason: "health_issue_reconciliation_not_current" };
  }
  if (issues.includes("account_state_stale")) {
    return { ok: false, reason: "health_issue_account_state_stale" };
  }

  const reconGen = asGeneration(recon.generation);
  const opGen = asGeneration(operational.generation);
  if (opGen === null) {
    return { ok: false, reason: "operational_generation_missing_or_invalid" };
  }
  if (reconGen === null) {
    return { ok: false, reason: "reconciliation_generation_missing_or_invalid" };
  }
  if (reconGen !== opGen) {
    return { ok: false, reason: "reconciliation_generation_mismatch" };
  }

  const succeededAt = typeof recon.lastSucceededAt === "string" ? recon.lastSucceededAt : null;
  const succeededMs = parseUtcMs(succeededAt);
  if (succeededMs === null) {
    return { ok: false, reason: "reconciliation_lastSucceededAt_missing" };
  }
  if (captureNowMs === null) {
    return { ok: false, reason: "capture_clock_missing" };
  }
  const ageMs = Math.max(0, captureNowMs - succeededMs);
  if (ageMs > maxAgeMs) {
    return { ok: false, reason: "reconciliation_lastSucceededAt_stale" };
  }
  return { ok: true, reason: "reconciliation_fresh" };
}

/**
 * Flat-idle exemption for missing/stale user lastEventAt.
 * Fail-closed unless every precondition holds.
 */
export function assessFlatIdleUserStream(input: {
  open_orders: OpenOrdersAssessment;
  account_flat: boolean;
  positions_present: boolean;
  positions_ambiguous: boolean;
  user_stream: StreamEventAssessment;
  market_stream: StreamEventAssessment;
  bbo: BboAssessment;
  operational: unknown;
  health: unknown;
  capture_now_ms: number | null;
  reconciliation_max_age_ms: number;
}): FlatIdleUserStreamAssessment {
  if (input.user_stream.recent_events) {
    return { eligible: false, reason: "user_stream_has_recent_events" };
  }
  if (!input.user_stream.connected) {
    return { eligible: false, reason: "user_stream_not_connected" };
  }
  if (!input.positions_present || input.positions_ambiguous) {
    return { eligible: false, reason: "positions_missing_or_ambiguous" };
  }
  if (!input.account_flat) {
    return { eligible: false, reason: "account_not_flat" };
  }
  if (!input.open_orders.confirmed_empty || input.open_orders.ambiguous) {
    return { eligible: false, reason: "open_orders_not_confirmed_empty" };
  }
  if (!input.market_stream.connected) {
    return { eligible: false, reason: "market_stream_not_connected" };
  }
  if (!input.market_stream.recent_events) {
    return { eligible: false, reason: "market_stream_events_not_recent" };
  }
  if (!input.bbo.complete || input.bbo.stale || input.bbo.ambiguous) {
    return { eligible: false, reason: "bbo_not_fresh" };
  }

  const recon = reconciliationFresh(
    input.operational,
    input.health,
    input.capture_now_ms,
    input.reconciliation_max_age_ms,
  );
  if (!recon.ok) {
    return { eligible: false, reason: recon.reason };
  }

  if (!isRecord(input.operational)) {
    return { eligible: false, reason: "operational_missing" };
  }
  const user = input.operational.userStream;
  const market = input.operational.marketStream;
  if (!isRecord(user) || !isRecord(market)) {
    return { eligible: false, reason: "stream_objects_missing" };
  }
  if (user.state === "reconnecting" || market.state === "reconnecting") {
    return { eligible: false, reason: "stream_reconnecting" };
  }

  return { eligible: true, reason: "flat_idle_user_stream_ok" };
}

export function evaluateControlledValidationGates(
  input: ControlledValidationGateInput,
): ControlledValidationGateResult {
  const streamMaxAge = input.stream_event_max_age_ms ?? 120_000;
  const bboMaxAge = input.bbo_max_age_ms ?? 6_000;
  const reconMaxAge = input.reconciliation_max_age_ms ?? streamMaxAge;
  const packetBudget = input.packet_budget_ms ?? 20_000;

  const health = input.health;
  const state = input.state;
  const packet = input.packet;

  const captureClock = resolveCaptureClock(health, state, {
    capture_now_ms: input.capture_now_ms,
    now_ms: input.now_ms,
  });
  const captureNowMs = captureClock?.ms ?? null;

  const openOrders = assessOpenOrders(state);
  const bbo = assessBbo(state, packet, {
    capture_now_ms: captureNowMs,
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
    { capture_now_ms: captureNowMs, max_age_ms: streamMaxAge, label: "user_stream" },
  );
  const marketStream = assessStreamEvents(
    isRecord(operational) ? operational.marketStream : null,
    { capture_now_ms: captureNowMs, max_age_ms: streamMaxAge, label: "market_stream" },
  );

  const flatness = accountIsFlat(state);
  const flatIdle = assessFlatIdleUserStream({
    open_orders: openOrders,
    account_flat: flatness.flat,
    positions_present: flatness.present,
    positions_ambiguous: flatness.ambiguous,
    user_stream: userStream,
    market_stream: marketStream,
    bbo,
    operational,
    health,
    capture_now_ms: captureNowMs,
    reconciliation_max_age_ms: reconMaxAge,
  });

  let userStreamMode: UserStreamMode = "insufficient";
  if (userStream.recent_events) userStreamMode = "recent_events";
  else if (flatIdle.eligible) userStreamMode = "flat_idle_user_stream";

  const notes: string[] = [
    "BBO freshness uses health.quote_age_ms or quote timestamp vs capture clock — never wall-clock Date.now() on frozen JSON.",
    userStreamMode === "flat_idle_user_stream"
      ? "user_stream_mode=flat_idle_user_stream: lastEventAt null/stale allowed only with flat account, empty openOrders, fresh reconciliation, user connected, market recent, BBO fresh."
      : "user_stream_mode requires recent user lastEventAt unless flat_idle_user_stream preconditions all hold (fail-closed).",
  ];
  if (captureClock === null) {
    notes.push("capture_clock missing: stream/BBO age checks fail closed unless health.quote_age_ms covers BBO.");
  }

  const status = isRecord(health) ? health.status : null;
  const tradingMode = isRecord(health) ? health.trading_mode : null;
  const delivery = isRecord(health) ? health.delivery_effective : null;
  const stateComplete = isRecord(health) && isRecord(health.data_quality)
    ? health.data_quality.state_complete === true
    : false;
  const reconOk = reconciliationFresh(operational, health, captureNowMs, reconMaxAge).ok;
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
    account_flat: flatness.present && !flatness.ambiguous && flatness.flat,
    unprotected_open_quantity_zero: unprotected === 0,
    bbo_complete: bbo.complete && !bbo.stale && !bbo.ambiguous,
    circuit_breaker_closed: cbClosed,
    reconciliation_ok: reconOk,
    user_stream_connected: userStream.connected,
    // Satisfied by recent user events OR explicit flat_idle_user_stream state.
    user_stream_recent_events: userStreamMode !== "insufficient",
    flat_idle_user_stream: userStreamMode === "flat_idle_user_stream",
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
  if (!flatness.present || flatness.ambiguous) gates.account_flat = false;

  // flat_idle_user_stream is a mode flag, not a mandatory gate when recent_events applies.
  const mandatoryGates = Object.entries(gates).filter(([name]) => name !== "flat_idle_user_stream");
  const failed = mandatoryGates
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    schema_version: "glitch.topstep.controlled_validation_gates.v2",
    all_passed: failed.length === 0,
    failed_gates: failed,
    open_orders: openOrders,
    bbo,
    user_stream: userStream,
    market_stream: marketStream,
    user_stream_mode: userStreamMode,
    flat_idle_user_stream: flatIdle,
    capture_clock: captureClock,
    gates,
    notes,
  };
}
