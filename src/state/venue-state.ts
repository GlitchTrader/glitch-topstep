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
} from "../domain/models.js";

interface Timed<T> {
  value: T;
  receivedAt: string;
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

  public registerContracts(contracts: ContractInfo[]): void {
    for (const contract of contracts) {
      this.contracts.set(contract.id, contract);
    }
  }

  public replaceAccounts(accounts: AccountInfo[], receivedAt = new Date().toISOString()): void {
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.set(account.id, { value: account, receivedAt });
    }
    this.accountSnapshotLoaded = true;
    this.accountSnapshotAt = receivedAt;
  }

  public replacePositions(positions: PositionInfo[], receivedAt = new Date().toISOString()): void {
    this.positions.clear();
    for (const position of positions) {
      this.positions.set(position.id, { value: position, receivedAt });
    }
    this.positionSnapshotLoaded = true;
    this.positionSnapshotAt = receivedAt;
  }

  public replaceOrders(orders: OrderInfo[], receivedAt = new Date().toISOString()): void {
    this.orders.clear();
    for (const order of orders) {
      this.orders.set(order.id, { value: order, receivedAt });
    }
    this.orderSnapshotLoaded = true;
    this.orderSnapshotAt = receivedAt;
  }

  public applyAccount(account: AccountInfo, receivedAt = new Date().toISOString()): void {
    this.accounts.set(account.id, { value: account, receivedAt });
    this.accountSnapshotAt = receivedAt;
  }

  public applyPosition(position: PositionInfo, receivedAt = new Date().toISOString()): void {
    this.positionSnapshotAt = receivedAt;
    if (position.size === 0 || position.type === 0) {
      this.positions.delete(position.id);
      return;
    }
    this.positions.set(position.id, { value: position, receivedAt });
  }

  public applyOrder(order: OrderInfo, receivedAt = new Date().toISOString()): void {
    this.orderSnapshotAt = receivedAt;
    if ([2, 3, 4, 5].includes(order.status)) {
      this.orders.delete(order.id);
      return;
    }
    this.orders.set(order.id, { value: order, receivedAt });
  }

  public applyTrade(trade: TradeInfo, receivedAt = new Date().toISOString()): void {
    this.trades.push({ value: trade, receivedAt });
    if (this.trades.length > 2_000) {
      this.trades.splice(0, this.trades.length - 2_000);
    }
  }

  public applyQuote(quote: QuoteInfo, receivedAt = new Date().toISOString()): void {
    this.quotes.set(quote.contractId, { value: quote, receivedAt });
  }

  public applyMarketTrade(trade: MarketTradeInfo, receivedAt = new Date().toISOString()): void {
    this.marketTrades.push({ value: trade, receivedAt });
    if (this.marketTrades.length > 5_000) {
      this.marketTrades.splice(0, this.marketTrades.length - 5_000);
    }
  }

  public applyDepth(depth: MarketDepthInfo, receivedAt = new Date().toISOString()): void {
    this.depth.push({ value: depth, receivedAt });
    if (this.depth.length > 10_000) {
      this.depth.splice(0, this.depth.length - 10_000);
    }
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
      stateComplete:
        this.accountSnapshotLoaded
        && this.positionSnapshotLoaded
        && this.orderSnapshotLoaded
        && quote !== null,
    };
  }

  public snapshotHash(snapshot: AccountVenueSnapshot): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
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
