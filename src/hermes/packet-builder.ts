import { createHash, randomUUID } from "node:crypto";
import type {
  AccountVenueSnapshot,
  RiskSettings,
  TopstepPolicyState,
} from "../domain/models.js";
import { calculateRiskBudget } from "../risk/mll.js";

export interface DirectDecisionPacket {
  schema_version: "glitch.direct.decision_packet.v1";
  packet_id: string;
  created_utc: string;
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
    symbol_id: string;
    tick_size: number;
    tick_value: number;
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
  policy: {
    program: "combine" | "xfa";
    account_size: number;
    initial_max_loss: number;
    highest_end_of_day_balance: number;
    liquidation_floor: number;
    current_buffer: number;
    allowed_risk_usd: number;
    max_contracts: number;
    entry_window_open: boolean;
  };
  execution: {
    state_complete: boolean;
    entry_actions_enabled: boolean;
    valid_entry_quantities: number[];
    authority: "Glitch validates and executes; Hermes proposes only";
  };
  required_output_template: Record<string, unknown>;
}

export function canonicalDecisionState(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
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
    stateComplete: snapshot.stateComplete,
    policy,
  };
}

export function decisionStateHash(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalDecisionState(snapshot, policy)))
    .digest("hex");
}

export function buildDecisionPacket(
  snapshot: AccountVenueSnapshot,
  policy: TopstepPolicyState,
  risk: RiskSettings,
  instrument: string,
): DirectDecisionPacket {
  const createdUtc = new Date().toISOString();
  const packetId = randomUUID();
  const riskBudget = calculateRiskBudget(
    snapshot.conservativeEquity,
    policy,
    risk.maxRiskFractionOfBuffer,
  );
  const remainingCapacity = Math.max(0, policy.maxContracts - snapshot.totalOpenContracts);
  const validEntryQuantities = snapshot.stateComplete && policy.entryWindowOpen
    ? Array.from({ length: remainingCapacity }, (_, index) => index + 1)
    : [];
  const quote = snapshot.quote;
  const snapshotHash = decisionStateHash(snapshot, policy);
  const defaultAction = snapshot.instrumentOpenContracts === 0 ? "NOTHING" : "HOLD";

  return {
    schema_version: "glitch.direct.decision_packet.v1",
    packet_id: packetId,
    created_utc: createdUtc,
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
      symbol_id: snapshot.contract.symbolId,
      tick_size: snapshot.contract.tickSize,
      tick_value: snapshot.contract.tickValue,
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
    policy: {
      program: policy.program,
      account_size: policy.accountSize,
      initial_max_loss: policy.initialMaxLoss,
      highest_end_of_day_balance: policy.highestEndOfDayBalance,
      liquidation_floor: riskBudget.liquidationFloor,
      current_buffer: riskBudget.currentBuffer,
      allowed_risk_usd: riskBudget.allowedRiskUsd,
      max_contracts: policy.maxContracts,
      entry_window_open: policy.entryWindowOpen,
    },
    execution: {
      state_complete: snapshot.stateComplete,
      entry_actions_enabled:
        snapshot.stateComplete
        && snapshot.account.canTrade
        && policy.entryWindowOpen
        && validEntryQuantities.length > 0,
      valid_entry_quantities: validEntryQuantities,
      authority: "Glitch validates and executes; Hermes proposes only",
    },
    required_output_template: {
      schema_version: "glitch.intent.v2",
      intent_id: "GENERATE_UUID",
      created_utc: createdUtc,
      instrument,
      account: snapshot.account.name,
      operator_profile: "glitch-toptrader",
      action: defaultAction,
      confidence: 0.5,
      snapshot_hash: snapshotHash,
      model_version: "CONFIGURED_MODEL",
      prompt_version: "glitch-toptrader-v1",
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
