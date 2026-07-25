import { createHash, randomUUID } from "node:crypto";
import type { ExecutionRecoveryStatus } from "../domain/execution-state.js";
import type { MarketObservationState } from "../domain/market-observation.js";
import type {
  AccountVenueSnapshot,
  RiskSettings,
  TopstepPolicyState,
} from "../domain/models.js";
import {
  GLITCH_TOPSTEP_OPERATOR_PROFILE,
  GLITCH_TOPSTEP_PROMPT_VERSION,
} from "../domain/operator.js";
import { calculateRiskBudget } from "../risk/mll.js";
import {
  evaluateSnapshotDataQuality,
  type SnapshotDataQuality,
} from "../state/data-quality.js";

export interface DirectDecisionPacket {
  schema_version: "glitch.direct.decision_packet.v2";
  packet_id: string;
  created_utc: string;
  expires_utc: string;
  venue: "projectx";
  firm: "topstep";
  instrument: string;
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
    volume: number | null;
  };
  market_observation: MarketObservationState;
  data_quality: {
    state_complete: boolean;
    issues: string[];
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
  execution: {
    gateway_mode: "disabled" | "shadow" | "armed";
    new_exposure_technically_supported: boolean;
    maximum_additional_contracts: number;
    recovery_blocked: boolean;
    entry_submission_pending: boolean;
    unresolved_mutations: number;
    ambiguous_mutations: number;
    last_recovery_utc: string | null;
    last_recovery_error: string | null;
    supported_actions: Array<"ENTER_LONG" | "ENTER_SHORT" | "HOLD" | "EXIT" | "NOTHING">;
    authority: "Hermes decides; Glitch verifies factual execution safety, translates orders, reconciles, journals, and protects";
  };
  required_output_template: Record<string, unknown>;
}

export function emptyMarketObservationState(): MarketObservationState {
  return {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
}

export function canonicalDecisionState(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
  recovery: ExecutionRecoveryStatus,
  quality: SnapshotDataQuality,
  marketObservation: MarketObservationState = emptyMarketObservationState(),
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
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalDecisionState(
      snapshot,
      policy,
      recovery,
      quality,
      marketObservation,
    )))
    .digest("hex");
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
): DirectDecisionPacket {
  const createdUtc = now.toISOString();
  const expiresUtc = new Date(now.getTime() + leaseMs).toISOString();
  const packetId = randomUUID();
  const riskBudget = calculateRiskBudget(snapshot.conservativeEquity, policy);
  const remainingCapacity = Math.max(0, policy.maxContracts - snapshot.totalOpenContracts);
  const quote = snapshot.quote;
  const quality = evaluateSnapshotDataQuality(snapshot, risk, now);
  const snapshotHash = decisionStateHash(
    snapshot,
    policy,
    recovery,
    quality,
    marketObservation,
  );
  const defaultAction = snapshot.instrumentOpenContracts === 0 ? "NOTHING" : "HOLD";

  return {
    schema_version: "glitch.direct.decision_packet.v2",
    packet_id: packetId,
    created_utc: createdUtc,
    expires_utc: expiresUtc,
    venue: "projectx",
    firm: "topstep",
    instrument,
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
      session_open: quote?.open ?? null,
      session_high: quote?.high ?? null,
      session_low: quote?.low ?? null,
      volume: quote?.volume ?? null,
    },
    market_observation: structuredClone(marketObservation),
    data_quality: {
      state_complete: quality.stateComplete,
      issues: [...quality.issues],
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
    execution: {
      gateway_mode: tradingMode,
      new_exposure_technically_supported:
        tradingMode !== "disabled"
        && quality.stateComplete
        && snapshot.account.canTrade
        && snapshot.instrumentOpenContracts === 0
        && snapshot.openOrders.length === 0
        && remainingCapacity > 0
        && !recovery.blockingNewExposure,
      maximum_additional_contracts: remainingCapacity,
      recovery_blocked: recovery.blockingNewExposure,
      entry_submission_pending: recovery.entrySubmissionPending,
      unresolved_mutations: recovery.unresolvedMutations,
      ambiguous_mutations: recovery.ambiguousMutations,
      last_recovery_utc: recovery.lastRecoveryUtc,
      last_recovery_error: recovery.lastRecoveryError,
      supported_actions: ["ENTER_LONG", "ENTER_SHORT", "HOLD", "EXIT", "NOTHING"],
      authority: "Hermes decides; Glitch verifies factual execution safety, translates orders, reconciles, journals, and protects",
    },
    required_output_template: {
      schema_version: "glitch.intent.v2",
      intent_id: "GENERATE_UUID",
      created_utc: createdUtc,
      instrument,
      account: snapshot.account.name,
      operator_profile: GLITCH_TOPSTEP_OPERATOR_PROFILE,
      action: defaultAction,
      confidence: 0.5,
      snapshot_hash: snapshotHash,
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
