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
  }

  public markPayloadFault(kind: VenueStreamKind, error: unknown, at = nowUtc()): void {
    this.setStream(kind, "degraded", error, at, true);
  }

  public markReconciliationStarted(at = nowUtc()): void {
    this.reconciliation = {
      ...this.reconciliation,
      state: "running",
      generation: this.generation,
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
      generation: this.generation,
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
    const totalOpenContracts = positions.reduce((sum, position) => sum + Math.abs(position.size), 0);
    const instrumentOpenContracts = positions
      .filter((position) => position.contractId === contractId)
      .reduce((sum, position) => sum + Math.abs(position.size), 0);
    const unrealizedPnl = quote
      ? positions.reduce((sum, position) => {
          const positionContract = this.contracts.get(position.contractId);
          const positionQuote = this.quotes.get(position.contractId)?.value;
          if (!positionContract || !positionQuote) {
            return sum;
          }
          const pointValue = positionContract.tickValue / positionContract.tickSize;
          const mark = position.type === 1 ? positionQuote.bestBid : positionQuote.bestAsk;
          const points = position.type === 1
            ? mark - position.averagePrice
            : position.averagePrice - mark;
          return sum + points * pointValue * position.size;
        }, 0)
      : 0;

    const operational = this.operationalStatus();
    const stateIssues = this.stateIssues(quote, operational);
    const capturedAt = this.latestStateTimestamp(accountId, contractId);
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
    if (
      operational.reconciliation.state !== "succeeded"
      || operational.reconciliation.generation !== operational.generation
    ) {
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

  private latestStateTimestamp(accountId: number, contractId: string): string {
    const required = [
      this.accounts.get(accountId)?.receivedAt ?? this.accountSnapshotAt,
      this.positionSnapshotAt,
      this.orderSnapshotAt,
      this.quotes.get(contractId)?.receivedAt ?? new Date(0).toISOString(),
    ];
    const oldest = Math.min(...required.map((value) => new Date(value).getTime()));
    return new Date(oldest).toISOString();
  }
}
