import type {
  AccountInfo,
  BarInfo,
  ContractInfo,
  MarketDepthInfo,
  MarketTradeInfo,
  OrderInfo,
  PositionInfo,
  QuoteInfo,
  TradeInfo,
} from "../domain/models.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`invalid_string:${key}`);
  }
  return field;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`invalid_number:${key}`);
  }
  return field;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`invalid_boolean:${key}`);
  }
  return field;
}

function nullableNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === null || field === undefined) {
    return null;
  }
  return requiredNumber(value, key);
}

export function parseAccount(input: unknown): AccountInfo {
  if (!isRecord(input)) throw new Error("account_not_object");
  return {
    id: requiredNumber(input, "id"),
    name: requiredString(input, "name"),
    balance: requiredNumber(input, "balance"),
    canTrade: requiredBoolean(input, "canTrade"),
    isVisible: requiredBoolean(input, "isVisible"),
    ...(typeof input.simulated === "boolean" ? { simulated: input.simulated } : {}),
  };
}

export function parseContract(input: unknown): ContractInfo {
  if (!isRecord(input)) throw new Error("contract_not_object");
  return {
    id: requiredString(input, "id"),
    name: requiredString(input, "name"),
    description: requiredString(input, "description"),
    tickSize: requiredNumber(input, "tickSize"),
    tickValue: requiredNumber(input, "tickValue"),
    activeContract: requiredBoolean(input, "activeContract"),
    symbolId: requiredString(input, "symbolId"),
  };
}

export function parsePosition(input: unknown): PositionInfo {
  if (!isRecord(input)) throw new Error("position_not_object");
  const type = requiredNumber(input, "type");
  if (![0, 1, 2].includes(type)) throw new Error("position_type_invalid");
  return {
    id: requiredNumber(input, "id"),
    accountId: requiredNumber(input, "accountId"),
    contractId: requiredString(input, "contractId"),
    creationTimestamp: requiredString(input, "creationTimestamp"),
    type: type as 0 | 1 | 2,
    size: requiredNumber(input, "size"),
    averagePrice: requiredNumber(input, "averagePrice"),
  };
}

export function parseOrder(input: unknown): OrderInfo {
  if (!isRecord(input)) throw new Error("order_not_object");
  return {
    id: requiredNumber(input, "id"),
    accountId: requiredNumber(input, "accountId"),
    contractId: requiredString(input, "contractId"),
    ...(typeof input.symbolId === "string" ? { symbolId: input.symbolId } : {}),
    creationTimestamp: requiredString(input, "creationTimestamp"),
    updateTimestamp: requiredString(input, "updateTimestamp"),
    status: requiredNumber(input, "status"),
    type: requiredNumber(input, "type"),
    side: requiredNumber(input, "side"),
    size: requiredNumber(input, "size"),
    limitPrice: nullableNumber(input, "limitPrice"),
    stopPrice: nullableNumber(input, "stopPrice"),
    ...(typeof input.fillVolume === "number" ? { fillVolume: input.fillVolume } : {}),
    ...(input.filledPrice === null || typeof input.filledPrice === "number"
      ? { filledPrice: input.filledPrice as number | null }
      : {}),
    ...(input.customTag === null || typeof input.customTag === "string"
      ? { customTag: input.customTag as string | null }
      : {}),
  };
}

export function parseTrade(input: unknown): TradeInfo {
  if (!isRecord(input)) throw new Error("trade_not_object");
  return {
    id: requiredNumber(input, "id"),
    accountId: requiredNumber(input, "accountId"),
    contractId: requiredString(input, "contractId"),
    creationTimestamp: requiredString(input, "creationTimestamp"),
    price: requiredNumber(input, "price"),
    profitAndLoss: nullableNumber(input, "profitAndLoss"),
    fees: nullableNumber(input, "fees"),
    side: requiredNumber(input, "side"),
    size: requiredNumber(input, "size"),
    voided: requiredBoolean(input, "voided"),
    orderId: requiredNumber(input, "orderId"),
  };
}

export function parseQuote(contractId: string, input: unknown): QuoteInfo {
  if (!isRecord(input)) throw new Error("quote_not_object");
  const bestBid = requiredNumber(input, "bestBid");
  const bestAsk = requiredNumber(input, "bestAsk");
  const lastPrice = nullableNumber(input, "lastPrice") ?? (bestBid + bestAsk) / 2;
  const open = nullableNumber(input, "open") ?? lastPrice;
  const high = nullableNumber(input, "high") ?? lastPrice;
  const low = nullableNumber(input, "low") ?? lastPrice;
  const volume = nullableNumber(input, "volume") ?? 0;
  const timestamp = typeof input.lastUpdated === "string" && input.lastUpdated.length > 0
    ? input.lastUpdated
    : requiredString(input, "timestamp");
  return {
    contractId,
    symbol: requiredString(input, "symbol"),
    ...(typeof input.symbolName === "string" ? { symbolName: input.symbolName } : {}),
    lastPrice,
    bestBid,
    bestAsk,
    open,
    high,
    low,
    volume,
    timestamp,
  };
}

export function parseMarketTrade(contractId: string, input: unknown): MarketTradeInfo {
  if (!isRecord(input)) throw new Error("market_trade_not_object");
  const type = requiredNumber(input, "type");
  if (![0, 1].includes(type)) throw new Error("market_trade_type_invalid");
  return {
    contractId,
    symbolId: requiredString(input, "symbolId"),
    price: requiredNumber(input, "price"),
    timestamp: requiredString(input, "timestamp"),
    type: type as 0 | 1,
    volume: requiredNumber(input, "volume"),
  };
}

export function parseDepth(contractId: string, input: unknown): MarketDepthInfo {
  if (!isRecord(input)) throw new Error("depth_not_object");
  return {
    contractId,
    timestamp: requiredString(input, "timestamp"),
    type: requiredNumber(input, "type"),
    price: requiredNumber(input, "price"),
    volume: requiredNumber(input, "volume"),
    currentVolume: requiredNumber(input, "currentVolume"),
  };
}

export function parseBar(input: unknown): BarInfo {
  if (!isRecord(input)) throw new Error("bar_not_object");
  return {
    timestamp: requiredString(input, "t"),
    open: requiredNumber(input, "o"),
    high: requiredNumber(input, "h"),
    low: requiredNumber(input, "l"),
    close: requiredNumber(input, "c"),
    volume: requiredNumber(input, "v"),
  };
}
