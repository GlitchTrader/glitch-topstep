import { createHash } from "node:crypto";
import type {
  AccountInfo,
  AccountVenueSnapshot,
  ContractInfo,
  MarketDepthInfo,
  MarketTradeInfo,
  OrderInfo,
  PositionInfo,
  QuoteInfo,
  TradeInfo,
  VenueOperationalStatus,
  VenueStreamKind,
  VenueStreamState,
} from "../domain/models.js";

function instrumentLegLots(position: PositionInfo): number {
  if (position.type === 0 || position.size === 0) {
    return 0;
  }
  return Math.abs(position.size);
}

/** Net open lots for one contract: |long − short|, not sum(abs) across offsetting legs. */
export function sumInstrumentNetContracts(
  positions: readonly PositionInfo[],
  contractId: string,
): number {
  let longLots = 0;
  let shortLots = 0;
  for (const position of positions) {
    if (position.contractId !== contractId) {
      continue;
    }
    const lots = instrumentLegLots(position);
    if (lots === 0) {
      continue;
    }
    if (position.type === 1) {
      longLots += lots;
    } else if (position.type === 2) {
      shortLots += lots;
    }
  }
  return Math.abs(longLots - shortLots);
}

/** Signed net lots: positive = net long, negative = net short. */
export function instrumentNetSignedLots(
  positions: readonly PositionInfo[],
  contractId: string,
): number {
  let longLots = 0;
  let shortLots = 0;
  for (const position of positions) {
    if (position.contractId !== contractId) {
      continue;
    }
    const lots = instrumentLegLots(position);
    if (lots === 0) {
      continue;
    }
    if (position.type === 1) {
      longLots += lots;
    } else if (position.type === 2) {
      shortLots += lots;
    }
  }
  return longLots - shortLots;
}

export function sumAccountNetContracts(positions: readonly PositionInfo[]): number {
  const contractIds = new Set<string>();
  for (const position of positions) {
    if (position.type !== 0 && position.size !== 0) {
      contractIds.add(position.contractId);
    }
  }
  let total = 0;
  for (const contractId of contractIds) {
    total += sumInstrumentNetContracts(positions, contractId);
  }
  return total;
}

/**
 * A successful reconciliation has proven the current operational generation. An in-flight
 * cycle keeps the previous proof; a stream gap bumps `generation` and invalidates it.
 */
export function isReconciliationCurrent(operational: VenueOperationalStatus): boolean {
  return operational.reconciliation.lastSucceededAt !== null
    && operational.reconciliation.generation === operational.generation;
}

interface Timed<T> {
  value: T;
  receivedAt: string;
}

function nowUtc(): string {
  return new Date().toISOString();
}

function initialStream(generation: number): VenueOperationalStatus["userStream"] {
  return {
    state: "disconnected",
    generation,
    lastChangedAt: nowUtc(),
    lastEventAt: null,
    lastError: null,
  };
}

export class VenueStateStore {
  private readonly accounts = new Map<number, Timed<AccountInfo>>();
  private readonly contracts = new Map<string, ContractInfo>();
  private readonly positions = new Map<number, Timed<PositionInfo>>();
  private readonly orders = new Map<number, Timed<OrderInfo>>();
  private readonly quotes = new Map<string, Timed<QuoteInfo>>();
  private readonly trades: Timed<TradeInfo>[] = [];
  private readonly marketTrades: Timed<MarketTradeInfo>[] = [];
  private readonly depth: Timed<MarketDepthInfo>[] = [];
  private accountSnapshotLoaded = false;
  private positionSnapshotLoaded = false;
  private orderSnapshotLoaded = false;
  private accountSnapshotAt = new Date(0).toISOString();
  private positionSnapshotAt = new Date(0).toISOString();
  private orderSnapshotAt = new Date(0).toISOString();
  private generation = 1;
  private userStream = initialStream(this.generation);
  private marketStream = initialStream(this.generation);
  private reconciliation: VenueOperationalStatus["reconciliation"] = {
    state: "idle",
    generation: 0,
    lastStartedAt: null,
    lastSucceededAt: null,
    lastError: null,
  };

  public registerContracts(contracts: ContractInfo[]): void {
    for (const contract of contracts) {
      this.contracts.set(contract.id, contract);
    }
  }

  public replaceAccounts(accounts: AccountInfo[], receivedAt = nowUtc()): void {
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.set(account.id, { value: account, receivedAt });
    }
    this.accountSnapshotLoaded = true;
    this.accountSnapshotAt = receivedAt;
  }

  public replacePositions(positions: PositionInfo[], receivedAt = nowUtc()): void {
    this.positions.clear();
    for (const position of positions) {
      this.positions.set(position.id, { value: position, receivedAt });
    }
    this.positionSnapshotLoaded = true;
    this.positionSnapshotAt = receivedAt;
  }

  public replaceOrders(orders: OrderInfo[], receivedAt = nowUtc()): void {
    this.orders.clear();
    for (const order of orders) {
      this.orders.set(order.id, { value: order, receivedAt });
    }
    this.orderSnapshotLoaded = true;
    this.orderSnapshotAt = receivedAt;
  }

  public applyAccount(account: AccountInfo, receivedAt = nowUtc()): void {
    this.accounts.set(account.id, { value: account, receivedAt });
    this.accountSnapshotAt = receivedAt;
  }

  public applyPosition(position: PositionInfo, receivedAt = nowUtc()): void {
    this.positionSnapshotAt = receivedAt;
    if (position.size === 0 || position.type === 0) {
      this.positions.delete(position.id);
      return;
    }
    this.positions.set(position.id, { value: position, receivedAt });
  }

  public applyOrder(order: OrderInfo, receivedAt = nowUtc()): void {
    this.orderSnapshotAt = receivedAt;
    if ([2, 3, 4, 5].includes(order.status)) {
      this.orders.delete(order.id);
      return;
    }
    this.orders.set(order.id, { value: order, receivedAt });
  }

  public applyTrade(trade: TradeInfo, receivedAt = nowUtc()): void {
    this.trades.push({ value: trade, receivedAt });
    if (this.trades.length > 2_000) {
      this.trades.splice(0, this.trades.length - 2_000);
    }
  }

  public applyQuote(quote: QuoteInfo, receivedAt = nowUtc()): void {
    this.quotes.set(quote.contractId, { value: quote, receivedAt });
  }

  public applyMarketTrade(trade: MarketTradeInfo, receivedAt = nowUtc()): void {
    this.marketTrades.push({ value: trade, receivedAt });
    if (this.marketTrades.length > 5_000) {
      this.marketTrades.splice(0, this.marketTrades.length - 5_000);
    }
  }

  public applyDepth(depth: MarketDepthInfo, receivedAt = nowUtc()): void {
    this.depth.push({ value: depth, receivedAt });
    if (this.depth.length > 10_000) {
      this.depth.splice(0, this.depth.length - 10_000);
    }
  }

  public markStreamConnecting(kind: VenueStreamKind, at = nowUtc()): void {
    this.setStream(kind, "connecting", null, at, false);
  }

  public markStreamConnected(kind: VenueStreamKind, at = nowUtc()): void {
    this.setStream(kind, "connected", null, at, false);
  }

  public markStreamReconnecting(kind: VenueStreamKind, error?: unknown, at = nowUtc()): void {
    this.setStream(kind, "reconnecting", error, at, true);
  }

  public markStreamDisconnected(kind: VenueStreamKind, error?: unknown, at = nowUtc()): void {
    this.setStream(kind, "disconnected", error, at, true);
  }

  public markStreamEvent(kind: VenueStreamKind, at = nowUtc()): void {
    const stream = this.stream(kind);
    stream.state = "connected";
    stream.generation = this.generation;
    stream.lastEventAt = at;
    stream.lastError = null;
  }

  public markPayloadFault(kind: VenueStreamKind, error: unknown, at = nowUtc()): void {
    this.setStream(kind, "degraded", error, at, true);
  }

  /**
   * `reconciliation.generation` tracks the generation the last *successful* reconciliation
   * proved, so starting or failing a cycle never retracts a proof we already have. A cycle in
   * flight does not make the previous snapshot wrong; only a stream gap (which bumps
   * `generation`) does.
   */
  public markReconciliationStarted(at = nowUtc()): void {
    this.reconciliation = {
      ...this.reconciliation,
      state: "running",
      lastStartedAt: at,
      lastError: null,
    };
  }

  public markReconciliationSucceeded(at = nowUtc()): void {
    this.reconciliation = {
      state: "succeeded",
      generation: this.generation,
      lastStartedAt: this.reconciliation.lastStartedAt,
      lastSucceededAt: at,
      lastError: null,
    };
  }

  public markReconciliationFailed(error: unknown, at = nowUtc()): void {
    this.reconciliation = {
      ...this.reconciliation,
      state: "failed",
      lastError: this.errorText(error),
      lastStartedAt: this.reconciliation.lastStartedAt ?? at,
    };
  }

  public operationalStatus(): VenueOperationalStatus {
    return {
      generation: this.generation,
      userStream: { ...this.userStream },
      marketStream: { ...this.marketStream },
      reconciliation: { ...this.reconciliation },
    };
  }

  public buildSnapshot(accountId: number, contractId: string): AccountVenueSnapshot {
    const account = this.accounts.get(accountId);
    const contract = this.contracts.get(contractId);
    if (!account) {
      throw new Error(`account_not_loaded:${accountId}`);
    }
    if (!contract) {
      throw new Error(`contract_not_loaded:${contractId}`);
    }

    const quote = this.quotes.get(contractId)?.value ?? null;
    const positions = [...this.positions.values()]
      .map((entry) => entry.value)
      .filter((position) => position.accountId === accountId);
    const openOrders = [...this.orders.values()]
      .map((entry) => entry.value)
      .filter((order) => order.accountId === accountId);
    const totalOpenContracts = sumAccountNetContracts(positions);
    const instrumentOpenContracts = sumInstrumentNetContracts(positions, contractId);

    const positionDataIssues = new Set<string>();
    const unrealizedPnl = positions.reduce((sum, position) => {
      const positionContract = this.contracts.get(position.contractId);
      if (!positionContract) {
        positionDataIssues.add(`position_contract_missing:${position.contractId}`);
        return sum;
      }
      const positionQuote = this.quotes.get(position.contractId)?.value;
      if (!positionQuote) {
        positionDataIssues.add(`position_quote_missing:${position.contractId}`);
        return sum;
      }
      const pointValue = positionContract.tickValue / positionContract.tickSize;
      const mark = position.type === 1 ? positionQuote.bestBid : positionQuote.bestAsk;
      const points = position.type === 1
        ? mark - position.averagePrice
        : position.averagePrice - mark;
      return sum + points * pointValue * position.size;
    }, 0);

    const operational = this.operationalStatus();
    const stateIssues = [
      ...this.stateIssues(quote, operational),
      ...positionDataIssues,
    ];
    const capturedAt = this.latestStateTimestamp(accountId);
    return {
      capturedAt,
      account: account.value,
      contract,
      quote,
      positions,
      openOrders,
      totalOpenContracts,
      instrumentOpenContracts,
      unrealizedPnl,
      conservativeEquity: account.value.balance + unrealizedPnl,
      operational,
      stateIssues,
      stateComplete: stateIssues.length === 0,
    };
  }

  public snapshotHash(snapshot: AccountVenueSnapshot): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  private stateIssues(
    quote: QuoteInfo | null,
    operational: VenueOperationalStatus,
  ): string[] {
    const issues: string[] = [];
    if (!this.accountSnapshotLoaded) issues.push("account_snapshot_missing");
    if (!this.positionSnapshotLoaded) issues.push("position_snapshot_missing");
    if (!this.orderSnapshotLoaded) issues.push("order_snapshot_missing");
    if (!quote) issues.push("quote_missing");
    if (operational.userStream.state !== "connected") issues.push(`user_stream_${operational.userStream.state}`);
    if (operational.marketStream.state !== "connected") issues.push(`market_stream_${operational.marketStream.state}`);
    if (!isReconciliationCurrent(operational)) {
      issues.push("reconciliation_not_current");
    }
    return issues;
  }

  private stream(kind: VenueStreamKind): VenueOperationalStatus["userStream"] {
    return kind === "user" ? this.userStream : this.marketStream;
  }

  private setStream(
    kind: VenueStreamKind,
    state: VenueStreamState,
    error: unknown,
    at: string,
    invalidatesGeneration: boolean,
  ): void {
    const current = this.stream(kind);
    if (invalidatesGeneration && current.state === "connected") {
      this.generation += 1;
    }
    const next = {
      ...current,
      state,
      generation: this.generation,
      lastChangedAt: at,
      lastError: error === null || error === undefined ? current.lastError : this.errorText(error),
    };
    if (kind === "user") {
      this.userStream = next;
    } else {
      this.marketStream = next;
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }

  /**
   * How current our view of the account is. Quotes are deliberately excluded: a quiet market
   * delivers no ticks, and that says nothing about whether account, position and order state
   * are synchronized. Price freshness is a separate concern, reported as `quote_stale`.
   */
  private latestStateTimestamp(accountId: number): string {
    const required = [
      this.accounts.get(accountId)?.receivedAt ?? this.accountSnapshotAt,
      this.positionSnapshotAt,
      this.orderSnapshotAt,
    ];
    const oldest = Math.min(...required.map((value) => new Date(value).getTime()));
    return new Date(oldest).toISOString();
  }
}
