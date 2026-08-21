import { createHash, randomUUID } from "node:crypto";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type {
  MarketObservationState,
  MarketObservationTimeframeMinutes,
  TimeframeMarketObservation,
} from "../domain/market-observation.js";
import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type {
  AccountVenueSnapshot,
  QuoteInfo,
  RiskSettings,
  TopstepPolicyState,
  TradeAction,
} from "../domain/models.js";
import type { AccountSelectionMode } from "../market/active-position-scope.js";
import { RUNTIME_ACCOUNT_SELECTION_MODE } from "../market/active-position-scope.js";
import type { ProjectXAuthStatus } from "../projectx/auth-manager.js";
import {
  resolvePacketProtectionStatus,
  type PacketProtectionStatus,
} from "../execution/bracket-verification.js";
import {
  buildExecutionGates,
  gatewayModePermitsRiskReduction,
  resolveGatewayMode,
  type EffectiveGatewayMode,
  type ExecutionGate,
} from "../execution/gateway-mode.js";
import {
  GLITCH_TOPSTEP_OPERATOR_PROFILE,
  GLITCH_TOPSTEP_PROMPT_VERSION,
} from "../domain/operator.js";
import { calculateRiskBudget } from "../risk/mll.js";
import {
  evaluateSnapshotDataQuality,
  type SnapshotDataQuality,
} from "../state/data-quality.js";
import {
  aggregateProtectionStatus,
  bindProtection,
  intentIdFromStopTag,
  type ResolvedProtection,
} from "../ownership/protection.js";
import { deriveScaleInSupportedAction } from "../ownership/scale-in.js";
import type { TrancheView } from "../ownership/tranches.js";
import {
  emptySessionConfig,
  resolveTopstepSession,
  type TopstepSessionConfig,
  type TopstepSessionPacket,
} from "../policy/session-calendar.js";
import type { DailyEconomicsPacket } from "../policy/daily-economics.js";
import {
  buildStreamHealthPacket,
  type StreamHealthPacket,
} from "../policy/stream-health.js";
import { buildStructuralLevels, type StructuralLevelsPacket } from "../market/structural-levels.js";
import {
  buildPriceDeltaRelationship,
  type PriceDeltaRelationshipPacket,
} from "../market/price-delta-relationship.js";

export interface DirectDecisionPacket {
  schema_version: "glitch.direct.decision_packet.v2";
  packet_id: string;
  created_utc: string;
  expires_utc: string;
  venue: "projectx";
  firm: "topstep";
  instrument: string;
  decision_scope: {
    contract_id: string;
    generation: number;
    scope_hash: string;
  };
  account_selection: {
    schema_version: "glitch.topstep.account_selection.v1";
    mode: AccountSelectionMode;
    selected_instrument: string;
    selected_contract_id: string;
    scope_generation: number;
    scope_hash: string;
    simultaneous_exposure_enabled: boolean;
  };
  account: {
    id: number;
    name: string;
    simulated: boolean | null;
    can_trade: boolean;
    balance: number;
    unrealized_pnl: number;
    conservative_equity: number;
    total_open_contracts: number;
    instrument_open_contracts: number;
    working_orders: number;
  };
  contract: {
    id: string;
    name: string;
    description: string;
    symbol_id: string;
    tick_size: number;
    tick_value: number;
    active_contract: boolean;
  };
  market: {
    snapshot_hash: string;
    quote_timestamp: string | null;
    last: number | null;
    bid: number | null;
    ask: number | null;
    spread_ticks: number | null;
    session_open: number | null;
    session_high: number | null;
    session_low: number | null;
    session_levels_reliable: boolean;
    session_levels_note?: string;
    session_levels: {
      available: boolean;
      reliable: boolean;
      high: number | null;
      low: number | null;
      reason?: string;
    };
    volume: number | null;
  };
  market_observation: MarketObservationState;
  order_flow: ProjectXOrderFlowState;
  structural_levels: StructuralLevelsPacket;
  price_delta_relationship: PriceDeltaRelationshipPacket;
  market_alignment: MarketAlignmentPacket;
  data_quality: {
    /** Venue/execution-critical completeness (streams, quote/state age). Matches execution gate state_complete. */
    state_complete: boolean;
    /** Required-quality defects that make state_complete false. */
    issues: string[];
    /** Non-blocking evidence gaps (e.g. DOM depth). Must not flip state_complete. */
    optional_issues: string[];
    quote_age_ms: number | null;
    state_age_ms: number | null;
    generation: number;
    user_stream_state: string;
    market_stream_state: string;
    reconciliation_state: string;
    reconciliation_generation: number;
    last_user_event_utc: string | null;
    last_market_event_utc: string | null;
    last_reconciled_utc: string | null;
  };
  policy: {
    account_stage: string;
    authority: string;
    verified_at_utc: string | null;
    loss_model: string;
    starting_balance: number;
    initial_maximum_loss: number;
    highest_end_of_day_balance: number;
    hard_loss_floor_usd: number;
    current_buffer_usd: number;
    max_contracts: number;
  };
  session: TopstepSessionPacket;
  stream_health: StreamHealthPacket;
  daily_economics?: DailyEconomicsPacket;
  execution: {
    gateway_mode: EffectiveGatewayMode;
    gateway_mode_configured: "disabled" | "shadow" | "armed";
    gateway_mode_downgrade_reason: string | null;
    gates: ExecutionGate[];
    new_exposure_technically_supported: boolean;
    maximum_additional_contracts: number;
    recovery_blocked: boolean;
    entry_submission_pending: boolean;
    daily_capture_locked: boolean;
    unresolved_mutations: number;
    ambiguous_mutations: number;
    last_recovery_utc: string | null;
    last_recovery_error: string | null;
    supported_actions: TradeAction[];
    authority: "Hermes decides; Glitch verifies factual execution safety, translates orders, reconciles, journals, and protects";
  };
  protection: {
    status: ResolvedProtection["status"];
    protection_status: PacketProtectionStatus;
    reason: string;
    intent_id: string | null;
    stop: {
      provider_order_id: number | null;
      custom_tag: string | null;
      price: number | null;
    } | null;
    target: {
      provider_order_id: number | null;
      custom_tag: string | null;
      price: number | null;
    } | null;
    tranches: TrancheView[];
  };
  required_output_template: Record<string, unknown>;
}

/** Advisory only — must never appear in data_quality.issues or execution gates. */
export const MARKET_ALIGNMENT_SYNCHRONIZED_MAX_LAG_MS = 90_000;

export type MarketAlignmentTimeframeKey = "1" | "5" | "15" | "60";

export interface MarketAlignmentBarSummary {
  latest_bar_open_utc: string | null;
  latest_bar_partial: boolean;
  observation_succeeded_utc: string | null;
  features_reference: "partial_bar" | "completed_bar" | null;
}

export interface MarketAlignmentPacket {
  packet_created_utc: string;
  quote_timestamp: string | null;
  order_flow_generated_utc: string | null;
  order_flow_last_trade_utc: string | null;
  bars: Partial<Record<MarketAlignmentTimeframeKey, MarketAlignmentBarSummary>>;
  lags_ms: {
    quote_vs_1m_bar_open: number | null;
    quote_vs_order_flow: number | null;
    packet_vs_observation_1m: number | null;
  };
  timing_reference: {
    price_for_timing: "quote";
    features_reference_1m: "partial_bar" | "completed_bar" | null;
  };
  synchronized: boolean;
  notes: string[];
}

const ALIGNMENT_TIMEFRAMES: MarketObservationTimeframeMinutes[] = [1, 5, 15, 60];

function alignmentTimeframeKey(
  minutes: MarketObservationTimeframeMinutes,
): MarketAlignmentTimeframeKey {
  return String(minutes) as MarketAlignmentTimeframeKey;
}

function timestampLagMs(laterMs: number, earlierUtc: string | null | undefined): number | null {
  if (!earlierUtc) {
    return null;
  }
  const earlierMs = Date.parse(earlierUtc);
  if (!Number.isFinite(earlierMs)) {
    return null;
  }
  return laterMs - earlierMs;
}

function summarizeAlignmentBar(
  timeframe: TimeframeMarketObservation | undefined,
  observationSucceededUtc: string | null,
): MarketAlignmentBarSummary | undefined {
  if (!timeframe) {
    return undefined;
  }
  return {
    latest_bar_open_utc: timeframe.latest_bar_utc,
    latest_bar_partial: timeframe.latest_bar_partial,
    observation_succeeded_utc: observationSucceededUtc,
    features_reference: timeframe.latest_bar_utc === null
      ? null
      : (timeframe.latest_bar_partial ? "partial_bar" : "completed_bar"),
  };
}

export function buildMarketAlignment(
  now: Date,
  quote: QuoteInfo | null | undefined,
  marketObservation: MarketObservationState,
  orderFlow: ProjectXOrderFlowState,
  quality: SnapshotDataQuality,
  risk: RiskSettings,
): MarketAlignmentPacket {
  const nowMs = now.getTime();
  const quoteTimestamp = quote?.timestamp ?? null;
  const observation = marketObservation.observation;
  const timeframes = observation?.timeframes ?? [];
  const tf1 = timeframes.find((row) => row.timeframe_minutes === 1);
  const observationSucceededUtc = marketObservation.last_succeeded_utc;
  const orderFlowGeneratedUtc = orderFlow.observation?.generated_utc ?? null;
  const orderFlowLastTradeUtc = orderFlow.observation?.last_trade_utc ?? null;

  const bars: Partial<Record<MarketAlignmentTimeframeKey, MarketAlignmentBarSummary>> = {};
  for (const minutes of ALIGNMENT_TIMEFRAMES) {
    const summary = summarizeAlignmentBar(
      timeframes.find((row) => row.timeframe_minutes === minutes),
      observationSucceededUtc,
    );
    if (summary) {
      bars[alignmentTimeframeKey(minutes)] = summary;
    }
  }

  const quoteMs = quoteTimestamp ? Date.parse(quoteTimestamp) : null;
  const barOpenMs = tf1?.latest_bar_utc ? Date.parse(tf1.latest_bar_utc) : null;
  const quoteVs1mBarOpen = quoteMs !== null && barOpenMs !== null && Number.isFinite(barOpenMs)
    ? quoteMs - barOpenMs
    : null;
  const quoteVsOrderFlow = quoteMs !== null
    ? timestampLagMs(quoteMs, orderFlowGeneratedUtc)
    : null;
  const packetVsObservation1m = timestampLagMs(nowMs, observationSucceededUtc);

  const featuresReference1m = !tf1 || tf1.latest_bar_utc === null
    ? null
    : (tf1.latest_bar_partial ? "partial_bar" : "completed_bar");

  const notes = [
    "market_alignment is cognition evidence only; never an execution gate.",
  ];
  if (featuresReference1m === "partial_bar") {
    notes.push("1m bar timestamps are candle open times; use quote bid/ask/last for executable timing.");
  }
  if (
    quoteVs1mBarOpen !== null
    && (quoteVs1mBarOpen < 0 || quoteVs1mBarOpen > MARKET_ALIGNMENT_SYNCHRONIZED_MAX_LAG_MS)
  ) {
    notes.push(
      "advisory_only: bar features may lag live quote; reduce timing confidence, not structural thesis.",
    );
  }

  const quoteAgeOk = quality.quoteAgeMs !== null && quality.quoteAgeMs <= risk.maxQuoteAgeMs;
  const synchronized = quoteAgeOk
    && marketObservation.last_error === null
    && quoteVs1mBarOpen !== null
    && quoteVs1mBarOpen >= 0
    && quoteVs1mBarOpen <= MARKET_ALIGNMENT_SYNCHRONIZED_MAX_LAG_MS
    && tf1?.latest_bar_utc !== null;

  return {
    packet_created_utc: now.toISOString(),
    quote_timestamp: quoteTimestamp,
    order_flow_generated_utc: orderFlowGeneratedUtc,
    order_flow_last_trade_utc: orderFlowLastTradeUtc,
    bars,
    lags_ms: {
      quote_vs_1m_bar_open: quoteVs1mBarOpen,
      quote_vs_order_flow: quoteVsOrderFlow,
      packet_vs_observation_1m: packetVsObservation1m,
    },
    timing_reference: {
      price_for_timing: "quote",
      features_reference_1m: featuresReference1m,
    },
    synchronized,
    notes,
  };
}

export function emptyMarketObservationState(): MarketObservationState {
  return {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
}

export function emptyOrderFlowState(): ProjectXOrderFlowState {
  return {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
}

/** Max |depth BBO − quote BBO| in ticks before reconstructed depth is treated as unusable. */
export const DEPTH_QUOTE_MAX_DIVERGENCE_TICKS = 4;

/**
 * Mark reconstructed depth unavailable when its BBO materially disagrees with the live quote.
 * Crossed-book cases are already cleared in buildDepthObservation; this catches mixed-state books
 * that still print a positive spread far from the tape.
 */
export function sanitizeOrderFlowDepthAgainstQuote(
  orderFlow: ProjectXOrderFlowState,
  quote: QuoteInfo | null | undefined,
  tickSize: number,
): ProjectXOrderFlowState {
  const depth = orderFlow.observation?.depth;
  if (!depth) {
    return orderFlow;
  }
  const next: ProjectXOrderFlowState = structuredClone(orderFlow);
  const nextDepth = next.observation!.depth;
  nextDepth.raw_available = depth.available;
  if (!depth.available || !quote || !Number.isFinite(tickSize) || tickSize <= 0) {
    nextDepth.integrity_valid = depth.available;
    return next;
  }
  if (depth.best_bid === null || depth.best_ask === null) {
    nextDepth.integrity_valid = false;
    return next;
  }
  if (!Number.isFinite(quote.bestBid) || !Number.isFinite(quote.bestAsk)) {
    nextDepth.integrity_valid = false;
    return next;
  }
  const bidTicks = Math.abs(depth.best_bid - quote.bestBid) / tickSize;
  const askTicks = Math.abs(depth.best_ask - quote.bestAsk) / tickSize;
  if (bidTicks <= DEPTH_QUOTE_MAX_DIVERGENCE_TICKS && askTicks <= DEPTH_QUOTE_MAX_DIVERGENCE_TICKS) {
    nextDepth.integrity_valid = true;
    return next;
  }
  nextDepth.available = false;
  nextDepth.integrity_valid = false;
  nextDepth.unavailable_reason = "depth_bbo_diverges_from_quote";
  nextDepth.imbalance_ratio = null;
  const issues = next.observation!.issues;
  if (!issues.includes("depth_bbo_diverges_from_quote")) {
    issues.push("depth_bbo_diverges_from_quote");
  }
  return next;
}

export function canonicalDecisionState(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
  recovery: ExecutionRecoveryStatus,
  quality: SnapshotDataQuality,
  marketObservation: MarketObservationState = emptyMarketObservationState(),
  orderFlow: ProjectXOrderFlowState = emptyOrderFlowState(),
): Record<string, unknown> {
  return {
    account: snapshot.account,
    contract: snapshot.contract,
    quote: snapshot.quote,
    positions: [...snapshot.positions].sort((left, right) => left.id - right.id),
    openOrders: [...snapshot.openOrders].sort((left, right) => left.id - right.id),
    totalOpenContracts: snapshot.totalOpenContracts,
    instrumentOpenContracts: snapshot.instrumentOpenContracts,
    unrealizedPnl: snapshot.unrealizedPnl,
    conservativeEquity: snapshot.conservativeEquity,
    operational: snapshot.operational,
    dataQuality: {
      stateComplete: quality.stateComplete,
      issues: quality.issues,
    },
    marketObservation,
    orderFlow,
    policy,
    recovery,
  };
}

export function decisionStateHash(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
  recovery: ExecutionRecoveryStatus,
  quality: SnapshotDataQuality,
  marketObservation: MarketObservationState = emptyMarketObservationState(),
  orderFlow: ProjectXOrderFlowState = emptyOrderFlowState(),
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalDecisionState(
      snapshot,
      policy,
      recovery,
      quality,
      marketObservation,
      orderFlow,
    )))
    .digest("hex");
}

export interface BracketVerificationContext {
  fillObservedUtc: string | null;
  stateComplete: boolean;
  nowUtc: string;
}

function attachProtectionStatus(
  protection: Omit<DirectDecisionPacket["protection"], "protection_status">,
  snapshot: AccountVenueSnapshot,
  verification: BracketVerificationContext | null,
): DirectDecisionPacket["protection"] {
  const positionOpen = snapshot.instrumentOpenContracts > 0;
  const resolved = resolvePacketProtectionStatus({
    positionOpen,
    internalStatus: protection.status,
    fillObservedUtc: verification?.fillObservedUtc ?? null,
    stateComplete: verification?.stateComplete ?? snapshot.stateComplete,
    nowUtc: verification?.nowUtc ?? new Date().toISOString(),
  });
  return {
    ...protection,
    protection_status: resolved.protection_status,
    reason: protection.reason || resolved.reason,
  };
}

export function derivePacketProtection(
  snapshot: AccountVenueSnapshot,
  activeIntentId: string | null = null,
  tranches: TrancheView[] = [],
  verification: BracketVerificationContext | null = null,
): DirectDecisionPacket["protection"] {
  const positionOpen = snapshot.instrumentOpenContracts > 0;
  if (!positionOpen) {
    return attachProtectionStatus({
      status: "unknown",
      reason: "no_open_position",
      intent_id: null,
      stop: null,
      target: null,
      tranches: [],
    }, snapshot, verification);
  }

  const activeTranches = tranches.filter((tranche) => tranche.remaining_qty > 0);
  if (activeTranches.length > 0) {
    // The position is protected only when every tranche holding contracts is protected.
    const status = aggregateProtectionStatus(activeTranches, true);
    const first = activeTranches.find((tranche) => tranche.protection.status !== "proven")
      ?? activeTranches[0]!;
    return attachProtectionStatus({
      status,
      reason: first.protection.reason,
      intent_id: first.intent_id,
      stop: first.protection.stop.provider_order_id === null
        ? null
        : {
            provider_order_id: first.protection.stop.provider_order_id,
            custom_tag: first.protection.stop.custom_tag,
            price: first.protection.stop.price,
          },
      target: first.protection.target.provider_order_id === null
        ? null
        : {
            provider_order_id: first.protection.target.provider_order_id,
            custom_tag: first.protection.target.custom_tag,
            price: first.protection.target.price,
          },
      tranches: activeTranches,
    }, snapshot, verification);
  }

  const intentId = activeIntentId
    ?? snapshot.openOrders
      .map((order) => (order.customTag ? intentIdFromStopTag(order.customTag) : null))
      .find((candidate) => candidate !== null)
    ?? null;
  if (!intentId) {
    return attachProtectionStatus({
      status: "pending",
      reason: "active_entry_intent_unresolved",
      intent_id: null,
      stop: null,
      target: null,
      tranches: [],
    }, snapshot, verification);
  }

  const protection = bindProtection(
    intentId,
    snapshot.openOrders,
    snapshot.account.id,
    snapshot.contract.id,
    true,
  );
  return attachProtectionStatus({
    status: protection.status,
    reason: protection.reason,
    intent_id: intentId,
    stop: protection.stop.providerOrderId === null
      ? null
      : {
          provider_order_id: protection.stop.providerOrderId,
          custom_tag: protection.stop.customTag,
          price: protection.stop.price,
        },
    target: protection.target.providerOrderId === null
      ? null
      : {
          provider_order_id: protection.target.providerOrderId,
          custom_tag: protection.target.customTag,
          price: protection.target.price,
        },
    tranches: [],
  }, snapshot, verification);
}

export function deriveSupportedActions(
  snapshot: AccountVenueSnapshot,
  protection: DirectDecisionPacket["protection"],
  remainingCapacity = 0,
  exitPermitted = true,
): TradeAction[] {
  const flat = snapshot.instrumentOpenContracts === 0;
  const base: TradeAction[] = flat
    ? (exitPermitted
      ? ["ENTER_LONG", "ENTER_SHORT", "HOLD", "EXIT", "NOTHING"]
      : ["ENTER_LONG", "ENTER_SHORT", "HOLD", "NOTHING"])
    : (exitPermitted ? ["HOLD", "EXIT", "NOTHING"] : ["HOLD", "NOTHING"]);
  const scaleInAction = deriveScaleInSupportedAction(
    snapshot,
    snapshot.contract.id,
    snapshot.account.id,
    remainingCapacity,
    protection.status === "proven",
  );
  if (scaleInAction !== null) {
    base.unshift(scaleInAction);
  }
  if (protection.status === "proven") {
    const tail = exitPermitted ? 2 : 1;
    return [...base.slice(0, base.length - tail), "MOVE_STOP", "MOVE_TP", ...base.slice(-tail)];
  }
  return base;
}

export function buildDecisionPacket(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
  risk: RiskSettings,
  recovery: ExecutionRecoveryStatus,
  instrument: string,
  tradingMode: "disabled" | "shadow" | "armed",
  leaseMs: number,
  now = new Date(),
  marketObservation: MarketObservationState = emptyMarketObservationState(),
  orderFlow: ProjectXOrderFlowState = emptyOrderFlowState(),
  tranches: TrancheView[] = [],
  session: TopstepSessionConfig = emptySessionConfig(),
  dailyEconomics: DailyEconomicsPacket | null = null,
  bracketVerification: BracketVerificationContext | null = null,
  decisionScope?: { generation: number; scopeHash: string },
  dailyCaptureLocked = false,
  simultaneousExposureEnabled = false,
  auth: ProjectXAuthStatus | null = null,
  accountSelectionMode: AccountSelectionMode = RUNTIME_ACCOUNT_SELECTION_MODE,
): DirectDecisionPacket {
  const createdUtc = now.toISOString();
  const expiresUtc = new Date(now.getTime() + leaseMs).toISOString();
  const packetId = randomUUID();
  const riskBudget = calculateRiskBudget(snapshot.conservativeEquity, policy);
  const remainingCapacity = Math.max(0, policy.maxContracts - snapshot.totalOpenContracts);
  const quote = snapshot.quote;
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  const publishedOrderFlow = sanitizeOrderFlowDepthAgainstQuote(
    orderFlow,
    quote,
    snapshot.contract.tickSize,
  );
  const snapshotHash = decisionStateHash(
    snapshot,
    policy,
    recovery,
    quality,
    marketObservation,
    publishedOrderFlow,
  );
  const defaultAction = snapshot.instrumentOpenContracts === 0 ? "NOTHING" : "HOLD";
  const gatewayMode = resolveGatewayMode(
    tradingMode,
    snapshot,
    risk,
    now,
  );
  const executionGates = buildExecutionGates(
    snapshot,
    risk,
    recovery,
    tradingMode,
    policy.maxContracts,
    now,
    auth ?? undefined,
  );
  const newExposureGate = executionGates.find((gate) => gate.id === "new_exposure_technically_supported");
  if (dailyCaptureLocked && newExposureGate) {
    newExposureGate.passed = false;
    newExposureGate.detail = [newExposureGate.detail, "daily_capture_locked"].filter(Boolean).join(",");
  }
  const protection = derivePacketProtection(snapshot, null, tranches, bracketVerification);
  // EXIT is live under degraded_armed; only disabled/shadow omit or shadow the submit path.
  const exitPermitted = tradingMode !== "disabled"
    && (tradingMode === "shadow" || gatewayModePermitsRiskReduction(gatewayMode.effective));
  const supportedActions = deriveSupportedActions(
    snapshot,
    protection,
    remainingCapacity,
    exitPermitted,
  ).filter((action) => !dailyCaptureLocked || (action !== "ENTER_LONG" && action !== "ENTER_SHORT"));
  const sessionLevels = resolveSessionMarketLevels(quote);
  // Required issues only — depth gaps stay optional evidence notes, not exposure gates.
  const requiredIssues = [...quality.issues];
  const optionalIssues: string[] = [];
  const depthObservation = publishedOrderFlow.observation?.depth;
  if (depthObservation?.available === false) {
    optionalIssues.push("order_flow_depth_unavailable");
  }

  const structuralLevels = buildStructuralLevels({
    generatedUtc: createdUtc,
    sessionHigh: sessionLevels.session_high,
    sessionLow: sessionLevels.session_low,
    sessionOpen: sessionLevels.session_open,
    sessionLevelsReliable: sessionLevels.reliable,
    marketObservation,
    orderFlow: publishedOrderFlow,
  });
  const priceDeltaRelationship = buildPriceDeltaRelationship(publishedOrderFlow, createdUtc);
  const marketAlignment = buildMarketAlignment(
    now,
    quote,
    marketObservation,
    publishedOrderFlow,
    quality,
    risk,
  );

  return {
    schema_version: "glitch.direct.decision_packet.v2",
    packet_id: packetId,
    created_utc: createdUtc,
    expires_utc: expiresUtc,
    venue: "projectx",
    firm: "topstep",
    instrument,
    decision_scope: {
      contract_id: snapshot.contract.id,
      generation: decisionScope?.generation ?? snapshot.operational.generation,
      scope_hash: decisionScope?.scopeHash ?? snapshotHash,
    },
    account_selection: {
      schema_version: "glitch.topstep.account_selection.v1",
      mode: accountSelectionMode,
      selected_instrument: instrument,
      selected_contract_id: snapshot.contract.id,
      scope_generation: decisionScope?.generation ?? snapshot.operational.generation,
      scope_hash: decisionScope?.scopeHash ?? snapshotHash,
      simultaneous_exposure_enabled: simultaneousExposureEnabled,
    },
    account: {
      id: snapshot.account.id,
      name: snapshot.account.name,
      simulated: snapshot.account.simulated ?? null,
      can_trade: snapshot.account.canTrade,
      balance: snapshot.account.balance,
      unrealized_pnl: snapshot.unrealizedPnl,
      conservative_equity: snapshot.conservativeEquity,
      total_open_contracts: snapshot.totalOpenContracts,
      instrument_open_contracts: snapshot.instrumentOpenContracts,
      working_orders: snapshot.openOrders.length,
    },
    contract: {
      id: snapshot.contract.id,
      name: snapshot.contract.name,
      description: snapshot.contract.description,
      symbol_id: snapshot.contract.symbolId,
      tick_size: snapshot.contract.tickSize,
      tick_value: snapshot.contract.tickValue,
      active_contract: snapshot.contract.activeContract,
    },
    market: {
      snapshot_hash: snapshotHash,
      quote_timestamp: quote?.timestamp ?? null,
      last: quote?.lastPrice ?? null,
      bid: quote?.bestBid ?? null,
      ask: quote?.bestAsk ?? null,
      spread_ticks: quote
        ? (quote.bestAsk - quote.bestBid) / snapshot.contract.tickSize
        : null,
      session_open: sessionLevels.session_open,
      session_high: sessionLevels.session_high,
      session_low: sessionLevels.session_low,
      session_levels_reliable: sessionLevels.session_levels.reliable,
      ...(sessionLevels.note === undefined ? {} : { session_levels_note: sessionLevels.note }),
      session_levels: sessionLevels.session_levels,
      volume: quote?.volume ?? null,
    },
    market_observation: structuredClone(marketObservation),
    order_flow: structuredClone(publishedOrderFlow),
    structural_levels: structuralLevels,
    price_delta_relationship: priceDeltaRelationship,
    market_alignment: marketAlignment,
    data_quality: {
      state_complete: requiredIssues.length === 0,
      issues: requiredIssues,
      optional_issues: optionalIssues,
      quote_age_ms: quality.quoteAgeMs,
      state_age_ms: quality.stateAgeMs,
      generation: snapshot.operational.generation,
      user_stream_state: snapshot.operational.userStream.state,
      market_stream_state: snapshot.operational.marketStream.state,
      reconciliation_state: snapshot.operational.reconciliation.state,
      reconciliation_generation: snapshot.operational.reconciliation.generation,
      last_user_event_utc: snapshot.operational.userStream.lastEventAt,
      last_market_event_utc: snapshot.operational.marketStream.lastEventAt,
      last_reconciled_utc: snapshot.operational.reconciliation.lastSucceededAt,
    },
    policy: {
      account_stage: policy.accountStage,
      authority: policy.authority,
      verified_at_utc: policy.verifiedAtUtc,
      loss_model: policy.lossModel,
      starting_balance: policy.startingBalance,
      initial_maximum_loss: policy.initialMaximumLoss,
      highest_end_of_day_balance: policy.highestEndOfDayBalance,
      hard_loss_floor_usd: riskBudget.liquidationFloor,
      current_buffer_usd: riskBudget.currentBuffer,
      max_contracts: policy.maxContracts,
    },
    session: resolveTopstepSession(session, now),
    stream_health: buildStreamHealthPacket(
      quality,
      orderFlow,
      snapshot.operational.marketStream.state,
      snapshot.operational.userStream.state,
      now,
    ),
    ...(dailyEconomics ? { daily_economics: dailyEconomics } : {}),
    execution: {
      gateway_mode: gatewayMode.effective,
      gateway_mode_configured: gatewayMode.configured,
      gateway_mode_downgrade_reason: gatewayMode.downgradeReason,
      gates: executionGates,
      new_exposure_technically_supported: newExposureGate?.passed ?? false,
      maximum_additional_contracts: remainingCapacity,
      recovery_blocked: recovery.blockingNewExposure,
      entry_submission_pending: recovery.entrySubmissionPending,
      daily_capture_locked: dailyCaptureLocked,
      unresolved_mutations: recovery.unresolvedMutations,
      ambiguous_mutations: recovery.ambiguousMutations,
      last_recovery_utc: recovery.lastRecoveryUtc,
      last_recovery_error: recovery.lastRecoveryError,
      supported_actions: supportedActions,
      authority: "Hermes decides; Glitch verifies factual execution safety, translates orders, reconciles, journals, and protects",
    },
    protection,
    required_output_template: {
      schema_version: "glitch.intent.v3",
      intent_id: "GENERATE_UUID",
      created_utc: createdUtc,
      instrument,
      account: snapshot.account.name,
      operator_profile: GLITCH_TOPSTEP_OPERATOR_PROFILE,
      action: defaultAction,
      confidence: 0.5,
      snapshot_hash: snapshotHash,
      packet_id: packetId,
      contract_id: snapshot.contract.id,
      scope_hash: decisionScope?.scopeHash ?? snapshotHash,
      scope_generation: decisionScope?.generation ?? snapshot.operational.generation,
      expires_utc: expiresUtc,
      entry_price_min: quote?.bestBid ?? null,
      entry_price_max: quote?.bestAsk ?? null,
      model_version: "CONFIGURED_MODEL",
      prompt_version: GLITCH_TOPSTEP_PROMPT_VERSION,
      reason: "Replace with a compact evidence-based reason.",
      decision_audit: {
        bull_case: "Replace",
        bear_case: "Replace",
        flat_case: "Replace",
        aggressive_case: "Replace",
        conservative_case: "Replace",
        decisive_evidence: "Replace",
        disconfirming_evidence: "Replace",
        change_condition: "Replace",
        final_choice: defaultAction,
      },
    },
  };
}

function resolveSessionMarketLevels(quote: QuoteInfo | null): {
  session_open: number | null;
  session_high: number | null;
  session_low: number | null;
  reliable: boolean;
  session_levels: DirectDecisionPacket["market"]["session_levels"];
  note?: string;
} {
  const mirrorNote =
    "session_high/low mirror last or session_open; prefer order_flow 60s high/low or observation range features";
  if (!quote) {
    return {
      session_open: null,
      session_high: null,
      session_low: null,
      reliable: false,
      session_levels: {
        available: false,
        reliable: false,
        high: null,
        low: null,
        reason: "quote_missing",
      },
    };
  }
  const last = quote.lastPrice;
  const open = quote.open;
  const high = quote.high;
  const low = quote.low;
  const available = high !== null && low !== null;
  let mirrorHeuristic = false;
  if (available && high === low && high === last) {
    mirrorHeuristic = true;
  } else if (available && high === low && high === open && open === last) {
    mirrorHeuristic = true;
  }
  const reliable = available && !mirrorHeuristic;
  const publishedHigh = reliable ? high : null;
  const publishedLow = reliable ? low : null;
  return {
    session_open: open,
    session_high: publishedHigh,
    session_low: publishedLow,
    reliable,
    session_levels: {
      available,
      reliable,
      high: available ? high : null,
      low: available ? low : null,
      ...(reliable
        ? {}
        : {
            reason: available ? "mirror_last_open_heuristic" : "session_high_low_missing",
          }),
    },
    ...(reliable ? {} : { note: mirrorNote }),
  };
}
