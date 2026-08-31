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

function isTrackedUserStreamIdField(key: string): boolean {
  if (key === "contractId" || key === "symbolId") {
    return false;
  }
  return key === "id" || key.endsWith("Id") || key.endsWith("ID");
}

/** ProjectX user hub sometimes wraps entity updates as `{ action, data }`. */
export function unwrapUserStreamPayload(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (!("data" in input) || !isRecord(input.data)) {
    return input;
  }
  if (!("action" in input)) {
    return input;
  }
  return input.data;
}

/** Sanitized operator detail when a user-stream payload fails strict ProjectX parsing. */
export function userStreamPayloadFaultDetail(
  eventType: string,
  input: unknown,
): Record<string, unknown> {
  const unwrapped = unwrapUserStreamPayload(input);
  if (!isRecord(unwrapped)) {
    return {
      eventType,
      payloadKind: unwrapped === null ? "null" : typeof unwrapped,
      wrapped: isRecord(input) && "data" in input,
    };
  }
  const idFieldTypes: Record<string, string> = {};
  for (const key of Object.keys(unwrapped).sort()) {
    if (!isTrackedUserStreamIdField(key)) {
      continue;
    }
    const field = unwrapped[key];
    idFieldTypes[key] = field === null
      ? "null"
      : Array.isArray(field)
        ? "array"
        : typeof field;
  }
  return {
    eventType,
    wrapped: unwrapped !== input,
    keys: Object.keys(unwrapped).sort(),
    idFieldTypes,
  };
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
  return coercedNumber(value, key);
}

export function parseAccount(input: unknown): AccountInfo {
  if (!isRecord(input)) throw new Error("account_not_object");
  return {
    id: coercedInteger(input, "id"),
    name: requiredString(input, "name"),
    balance: coercedNumber(input, "balance"),
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
  const type = coercedIntegerOptional(input, "type", 0);
  if (![0, 1, 2].includes(type)) throw new Error("position_type_invalid");
  return {
    id: coercedInteger(input, "id"),
    accountId: coercedInteger(input, "accountId"),
    contractId: requiredString(input, "contractId"),
    creationTimestamp: requiredString(input, "creationTimestamp"),
    type: type as 0 | 1 | 2,
    size: coercedNumber(input, "size"),
    averagePrice: coercedNumber(input, "averagePrice"),
  };
}

export function parseOrder(input: unknown): OrderInfo {
  if (!isRecord(input)) throw new Error("order_not_object");
  return {
    // ponytail: live #29 observed orderId without id; REST place returns orderId. Canonical stream field is id.
    id: coercedIntegerField(input, "id", "orderId"),
    accountId: coercedInteger(input, "accountId"),
    contractId: requiredString(input, "contractId"),
    ...(typeof input.symbolId === "string" ? { symbolId: input.symbolId } : {}),
    creationTimestamp: requiredString(input, "creationTimestamp"),
    // D5: legacy docs show updateTimestamp can be null; fall back to creationTimestamp
    // instead of rejecting the event as a payload fault (never observed live, cheap to guard).
    updateTimestamp: typeof input.updateTimestamp === "string" && input.updateTimestamp.length > 0
      ? input.updateTimestamp
      : requiredString(input, "creationTimestamp"),
    status: coercedInteger(input, "status"),
    type: coercedInteger(input, "type"),
    side: coercedInteger(input, "side"),
    size: coercedNumber(input, "size"),
    limitPrice: nullableNumber(input, "limitPrice"),
    stopPrice: nullableNumber(input, "stopPrice"),
    ...(input.fillVolume === null || input.fillVolume === undefined
      ? {}
      : { fillVolume: coercedNumber(input, "fillVolume") }),
    ...(input.filledPrice === null || typeof input.filledPrice === "number"
      ? { filledPrice: input.filledPrice as number | null }
      : {}),
    ...(input.customTag === null || typeof input.customTag === "string"
      ? { customTag: input.customTag as string | null }
      : {}),
    ...(input.parentOrderId === null || input.parentOrderId === undefined
      ? {}
      : { parentOrderId: coercedInteger(input, "parentOrderId") }),
    ...(input.linkedOrderId === null || input.linkedOrderId === undefined
      ? {}
      : { linkedOrderId: coercedInteger(input, "linkedOrderId") }),
  };
}

export function parseTrade(input: unknown): TradeInfo {
  if (!isRecord(input)) throw new Error("trade_not_object");
  return {
    id: coercedInteger(input, "id"),
    accountId: coercedInteger(input, "accountId"),
    contractId: requiredString(input, "contractId"),
    creationTimestamp: requiredString(input, "creationTimestamp"),
    price: coercedNumber(input, "price"),
    profitAndLoss: nullableNumber(input, "profitAndLoss"),
    fees: nullableNumber(input, "fees"),
    side: coercedInteger(input, "side"),
    size: coercedNumber(input, "size"),
    voided: requiredBoolean(input, "voided"),
    orderId: coercedInteger(input, "orderId"),
  };
}

export function parseQuote(contractId: string, input: unknown): QuoteInfo {
  if (!isRecord(input)) throw new Error("quote_not_object");
  const bestBid = nullableNumber(input, "bestBid");
  const bestAsk = nullableNumber(input, "bestAsk");
  const lastPrice = nullableNumber(input, "lastPrice");
  const resolvedLast = lastPrice
    ?? (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null)
    ?? bestBid
    ?? bestAsk;
  if (resolvedLast === null) {
    throw new Error("quote_price_missing");
  }
  const resolvedBid = bestBid ?? resolvedLast;
  const resolvedAsk = bestAsk ?? resolvedLast;
  const open = nullableNumber(input, "open") ?? resolvedLast;
  const high = nullableNumber(input, "high") ?? resolvedLast;
  const low = nullableNumber(input, "low") ?? resolvedLast;
  const volume = nullableNumber(input, "volume") ?? 0;
  const timestamp = typeof input.lastUpdated === "string" && input.lastUpdated.length > 0
    ? input.lastUpdated
    : requiredString(input, "timestamp");
  return {
    contractId,
    symbol: requiredString(input, "symbol"),
    ...(typeof input.symbolName === "string" ? { symbolName: input.symbolName } : {}),
    lastPrice: resolvedLast,
    bestBid: resolvedBid,
    bestAsk: resolvedAsk,
    open,
    high,
    low,
    volume,
    timestamp,
  };
}

export function unwrapMarketStreamArgs(
  contractId: unknown,
  input: unknown,
): { contractId: string; payload: unknown } {
  if (Array.isArray(contractId)) {
    if (contractId.length >= 2 && typeof contractId[0] === "string") {
      return { contractId: contractId[0], payload: contractId[1] };
    }
    if (contractId.length === 1) {
      return unwrapMarketStreamArgs(contractId[0], undefined);
    }
  }

  if (isRecord(contractId) && input === undefined) {
    const envelopeContractId = contractId.contractId;
    if (typeof envelopeContractId === "string") {
      const nested = contractId.data ?? contractId.payload;
      return {
        contractId: envelopeContractId,
        payload: isRecord(nested) ? nested : stripEnvelopeKeys(contractId),
      };
    }
  }

  if (typeof contractId !== "string") {
    throw new Error("market_stream_contract_id_invalid");
  }

  if (Array.isArray(input) && input.length >= 2 && typeof input[0] === "string" && isRecord(input[1])) {
    return { contractId: input[0], payload: input[1] };
  }

  return { contractId, payload: input };
}

function stripEnvelopeKeys(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  delete next.contractId;
  delete next.data;
  delete next.payload;
  return next;
}

function normalizeMarketPayload(
  contractId: string,
  payload: unknown,
  kind: "market_trade" | "depth",
): Record<string, unknown> {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error(kind === "market_trade" ? "market_trade_not_object" : "depth_not_object");
    }
  }

  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === "string" && isRecord(value[1])) {
      return { contractId: value[0], ...value[1] };
    }
    if (value.length >= 1) {
      const firstRecord = value.find((entry) => isRecord(entry));
      if (firstRecord) {
        return { contractId, ...firstRecord };
      }
    }
    const mapped = mapPrimitiveMarketArray(value, kind);
    if (mapped) {
      return { contractId, ...mapped };
    }
    throw new Error(kind === "market_trade" ? "market_trade_not_object" : "depth_not_object");
  }

  if (!isRecord(value)) {
    throw new Error(kind === "market_trade" ? "market_trade_not_object" : "depth_not_object");
  }

  const nested = value.data ?? value.payload;
  if (Array.isArray(nested)) {
    const firstRecord = nested.find((entry) => isRecord(entry));
    if (firstRecord) {
      return { contractId, ...firstRecord };
    }
  }
  if (isRecord(nested)) {
    return { contractId, ...nested };
  }

  return { contractId, ...value };
}

function mapPrimitiveMarketArray(
  values: unknown[],
  kind: "market_trade" | "depth",
): Record<string, unknown> | null {
  if (values.length === 1 && isRecord(values[0])) {
    return values[0];
  }
  if (kind === "market_trade" && values.length >= 5) {
    return {
      symbolId: values[0],
      price: values[1],
      timestamp: values[2],
      type: values[3],
      volume: values[4],
    };
  }
  if (kind === "depth" && values.length >= 5) {
    return {
      timestamp: values[0],
      type: values[1],
      price: values[2],
      volume: values[3],
      currentVolume: values[4],
    };
  }
  return null;
}

function coercedIntegerOptional(
  value: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  if (!(key in value) || value[key] === null || value[key] === undefined) {
    return defaultValue;
  }
  return coercedInteger(value, key);
}

function coercedNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field === "number" && Number.isFinite(field)) {
    return field;
  }
  if (typeof field === "string" && field.trim().length > 0) {
    const parsed = Number(field);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`invalid_number:${key}`);
}

function coercedInteger(value: Record<string, unknown>, key: string): number {
  const parsed = coercedNumber(value, key);
  const rounded = Math.round(parsed);
  if (Math.abs(parsed - rounded) > 1e-6) {
    throw new Error(`invalid_number:${key}`);
  }
  return rounded;
}

function coercedIntegerField(value: Record<string, unknown>, ...keys: string[]): number {
  let lastError: Error | null = null;
  for (const key of keys) {
    if (!(key in value) || value[key] === null || value[key] === undefined) {
      continue;
    }
    try {
      return coercedInteger(value, key);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(`invalid_number:${key}`);
    }
  }
  throw lastError ?? new Error(`invalid_number:${keys[0]}`);
}

export function parseMarketTrade(contractId: string, input: unknown): MarketTradeInfo {
  const normalized = normalizeMarketPayload(contractId, input, "market_trade");
  const type = coercedInteger(normalized, "type");
  if (![0, 1].includes(type)) throw new Error("market_trade_type_invalid");
  return {
    contractId: requiredString(normalized, "contractId"),
    symbolId: requiredString(normalized, "symbolId"),
    price: coercedNumber(normalized, "price"),
    timestamp: requiredString(normalized, "timestamp"),
    type: type as 0 | 1,
    volume: coercedNumber(normalized, "volume"),
  };
}

export function parseDepth(contractId: string, input: unknown): MarketDepthInfo {
  const normalized = normalizeMarketPayload(contractId, input, "depth");
  return parseDepthRecord(normalized);
}

/**
 * ProjectX often batches several DomType updates in one GatewayDepth push.
 * Collapsing to the first record drops sibling BestBid/BestAsk and empties the book.
 */
export function parseDepthBatch(contractId: string, input: unknown): MarketDepthInfo[] {
  return expandDepthPayloadRecords(contractId, input).map((record) => parseDepthRecord(record));
}

function parseDepthRecord(normalized: Record<string, unknown>): MarketDepthInfo {
  return {
    contractId: requiredString(normalized, "contractId"),
    timestamp: requiredString(normalized, "timestamp"),
    type: coercedInteger(normalized, "type"),
    price: coercedNumber(normalized, "price"),
    volume: coercedNumber(normalized, "volume"),
    currentVolume: coercedNumber(normalized, "currentVolume"),
  };
}

export function expandDepthPayloadRecords(
  contractId: string,
  payload: unknown,
): Record<string, unknown>[] {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error("depth_not_object");
    }
  }

  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === "string" && isRecord(value[1])) {
      return expandDepthPayloadRecords(value[0], value[1]);
    }
    const records = value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    if (records.length > 0) {
      return records.map((record) => ({ contractId, ...record }));
    }
    const mapped = mapPrimitiveMarketArray(value, "depth");
    if (mapped) {
      return [{ contractId, ...mapped }];
    }
    throw new Error("depth_not_object");
  }

  if (!isRecord(value)) {
    throw new Error("depth_not_object");
  }

  const nested = value.data ?? value.payload;
  if (Array.isArray(nested)) {
    const records = nested.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    if (records.length > 0) {
      const baseContract = typeof value.contractId === "string" ? value.contractId : contractId;
      return records.map((record) => ({ contractId: baseContract, ...record }));
    }
  }
  if (isRecord(nested)) {
    const baseContract = typeof value.contractId === "string" ? value.contractId : contractId;
    return [{ contractId: baseContract, ...nested }];
  }

  return [{ contractId, ...stripEnvelopeKeys(value) }];
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
