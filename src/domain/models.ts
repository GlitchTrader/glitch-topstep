export const TradeActions = [
  "ENTER_LONG",
  "ENTER_SHORT",
  "HOLD",
  "MOVE_STOP",
  "MOVE_TP",
  "EXIT",
  "NOTHING",
] as const;

export type TradeAction = (typeof TradeActions)[number];

export interface AccountInfo {
  id: number;
  name: string;
  balance: number;
  canTrade: boolean;
  isVisible: boolean;
  simulated?: boolean;
}

export interface ContractInfo {
  id: string;
  name: string;
  description: string;
  tickSize: number;
  tickValue: number;
  activeContract: boolean;
  symbolId: string;
}

export interface PositionInfo {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  type: 0 | 1 | 2;
  size: number;
  averagePrice: number;
}

export interface OrderInfo {
  id: number;
  accountId: number;
  contractId: string;
  symbolId?: string;
  creationTimestamp: string;
  updateTimestamp: string;
  status: number;
  type: number;
  side: number;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  fillVolume?: number;
  filledPrice?: number | null;
  customTag?: string | null;
}

export interface TradeInfo {
  id: number;
  accountId: number;
  contractId: string;
  creationTimestamp: string;
  price: number;
  profitAndLoss: number | null;
  fees: number | null;
  side: number;
  size: number;
  voided: boolean;
  orderId: number;
}

export interface QuoteInfo {
  contractId: string;
  symbol: string;
  symbolName?: string;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  timestamp: string;
}

export interface MarketTradeInfo {
  contractId: string;
  symbolId: string;
  price: number;
  timestamp: string;
  type: 0 | 1;
  volume: number;
}

export interface MarketDepthInfo {
  contractId: string;
  timestamp: string;
  type: number;
  price: number;
  volume: number;
  currentVolume: number;
}

export interface BarInfo {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type VenueStreamKind = "user" | "market";
export type VenueStreamState = "disconnected" | "connecting" | "connected" | "reconnecting" | "degraded";
export type ReconciliationState = "idle" | "running" | "succeeded" | "failed";

export interface VenueStreamStatus {
  state: VenueStreamState;
  generation: number;
  lastChangedAt: string;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface VenueReconciliationStatus {
  state: ReconciliationState;
  generation: number;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastError: string | null;
}

export interface VenueOperationalStatus {
  generation: number;
  userStream: VenueStreamStatus;
  marketStream: VenueStreamStatus;
  reconciliation: VenueReconciliationStatus;
}

export interface AccountVenueSnapshot {
  capturedAt: string;
  account: AccountInfo;
  contract: ContractInfo;
  quote: QuoteInfo | null;
  positions: PositionInfo[];
  openOrders: OrderInfo[];
  totalOpenContracts: number;
  instrumentOpenContracts: number;
  unrealizedPnl: number;
  conservativeEquity: number;
  operational: VenueOperationalStatus;
  stateIssues: string[];
  stateComplete: boolean;
}

export type TopstepLossModel = "trading_combine_eod" | "express_funded_eod" | "operator_provided_floor";
export type TopstepPolicyAuthority = "operator_configured" | "provider_reconciled";

export interface TopstepPolicyState {
  accountStage: string;
  lossModel: TopstepLossModel;
  authority: TopstepPolicyAuthority;
  verifiedAtUtc: string | null;
  startingBalance: number;
  initialMaximumLoss: number;
  highestEndOfDayBalance: number;
  lossFloorLockedAtZero: boolean;
  payoutProcessed: boolean;
  operatorProvidedLossFloorUsd: number | null;
  maxContracts: number;
}

export interface RiskSettings {
  estimatedRoundTurnFeesUsd: number;
  slippageReserveTicks: number;
  maxQuoteAgeMs: number;
  maxStateAgeMs: number;
  maxIntentAgeMs: number;
}

export interface RiskBudget {
  liquidationFloor: number;
  currentBuffer: number;
}

export interface DecisionAudit {
  bullCase: string;
  bearCase: string;
  flatCase: string;
  aggressiveCase: string;
  conservativeCase: string;
  decisiveEvidence: string;
  disconfirmingEvidence: string;
  changeCondition: string;
  finalChoice: TradeAction;
}

export interface TradeIntent {
  schemaVersion: "glitch.intent.v2";
  intentId: string;
  createdUtc: string;
  instrument: string;
  account: string;
  operatorProfile: string;
  action: TradeAction;
  confidence: number;
  snapshotHash: string;
  modelVersion: string;
  promptVersion: string;
  reason: string;
  decisionAudit: DecisionAudit;
  quantity?: number;
  orderType?: "MARKET";
  stopLoss?: number;
  takeProfit1?: number;
  newStopPrice?: number;
  newTakeProfit?: number;
  exitFraction?: number;
}

export interface ValidatedEntry {
  intent: TradeIntent;
  account: AccountInfo;
  contract: ContractInfo;
  /** Validated contract count; always a positive integer. */
  quantity: number;
  referencePrice: number;
  riskUsd: number;
  riskBudget: RiskBudget;
  stopTicks: number;
  targetTicks: number;
  customTag: string;
}

export type TradingMode = "disabled" | "shadow" | "armed";
