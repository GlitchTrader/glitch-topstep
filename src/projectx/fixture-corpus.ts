import type { OrderInfo, TradeInfo } from "../domain/models.js";
import {
  PROJECTX_MARKET_STREAM_EVENT_TYPES,
  PROJECTX_STREAM_CONNECTED_LIFECYCLE_EVENTS,
  PROJECTX_USER_STREAM_EVENT_TYPES,
} from "./stream-subscriptions.js";

export const FIXTURE_CORPUS_SCHEMA = "glitch.projectx.fixture_capture.v1" as const;

export const REQUIRED_FIXTURE_NAMES = [
  "auth_login",
  "auth_login_key_envelope",
  "auth_validate",
  "auth_validate_envelope",
  "accounts_search",
  "contracts_available",
  "open_positions",
  "open_orders",
  "historical_orders_24h",
  "historical_trades_24h",
  "history_bars_1m_2h",
  "gateway_health",
  "stream_event_samples",
  "stream_subscriptions_proof",
  "reconnect_proof",
] as const;

export interface FixtureManifest {
  schema_version: string;
  captured_utc: string;
  secret_scan: string;
  history_search_window_hours?: number;
  files: Array<{ name: string; path: string }>;
}

export interface StreamEventSample {
  event_type: string;
  source: string;
  raw_payload: unknown;
}

export function validateFixtureManifest(manifest: FixtureManifest): string[] {
  const failures: string[] = [];
  if (manifest.schema_version !== FIXTURE_CORPUS_SCHEMA) {
    failures.push("manifest_schema_invalid");
  }
  if (manifest.secret_scan !== "passed") {
    failures.push("manifest_secret_scan_not_passed");
  }
  for (const name of REQUIRED_FIXTURE_NAMES) {
    if (!manifest.files.some((entry) => entry.name === name)) {
      failures.push(`manifest_missing:${name}`);
    }
  }
  return failures;
}

export function validateAuthEnvelopeFixture(
  fixture: { envelope?: Record<string, unknown> },
  label: string,
): string[] {
  const failures: string[] = [];
  const envelope = fixture.envelope;
  if (!envelope) {
    failures.push(`${label}:envelope_missing`);
    return failures;
  }
  if (envelope.success !== true) {
    failures.push(`${label}:success_not_true`);
  }
  if (envelope.errorCode !== 0) {
    failures.push(`${label}:error_code_not_zero`);
  }
  if (envelope.errorMessage !== null && typeof envelope.errorMessage !== "string") {
    failures.push(`${label}:error_message_shape_invalid`);
  }
  return failures;
}

export function validateStreamEventCorpus(samples: StreamEventSample[]): string[] {
  const failures: string[] = [];
  const hasPayload = (source: string, eventType: string) => samples.some(
    (sample) => sample.source === source
      && sample.event_type === eventType
      && sample.raw_payload !== null
      && sample.raw_payload !== undefined,
  );

  for (const eventType of PROJECTX_USER_STREAM_EVENT_TYPES) {
    if (!hasPayload("projectx_user_stream", eventType)) {
      failures.push(`user_stream_event_missing:${eventType}`);
    }
  }
  for (const eventType of PROJECTX_MARKET_STREAM_EVENT_TYPES) {
    if (!hasPayload("projectx_market_stream", eventType)) {
      failures.push(`market_stream_event_missing:${eventType}`);
    }
  }
  for (const eventType of PROJECTX_STREAM_CONNECTED_LIFECYCLE_EVENTS) {
    if (!samples.some((sample) => sample.source === "projectx_lifecycle" && sample.event_type === eventType)) {
      failures.push(`lifecycle_event_missing:${eventType}`);
    }
  }
  return failures;
}

const GLT_CUSTOM_TAG_PREFIX = "glt-";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function validateHistoricalSearchFixtures(
  orders: OrderInfo[],
  trades: TradeInfo[],
): string[] {
  const failures: string[] = [];
  if (orders.length === 0) {
    failures.push("historical_orders_empty");
    return failures;
  }
  if (trades.length === 0) {
    failures.push("historical_trades_empty");
    return failures;
  }

  const orderIds = new Set<number>();
  let taggedOrderCount = 0;
  for (const order of orders) {
    if (!isPositiveInteger(order.id)) {
      failures.push("historical_order_id_invalid");
    } else {
      orderIds.add(order.id);
    }
    if (!isPositiveInteger(order.accountId)) {
      failures.push("historical_order_account_id_invalid");
    }
    if (typeof order.contractId !== "string" || order.contractId.length === 0) {
      failures.push("historical_order_contract_id_invalid");
    }
    if (typeof order.creationTimestamp !== "string" || order.creationTimestamp.length === 0) {
      failures.push("historical_order_creation_timestamp_invalid");
    }
    if (typeof order.customTag === "string" && order.customTag.startsWith(GLT_CUSTOM_TAG_PREFIX)) {
      taggedOrderCount += 1;
    }
  }
  if (taggedOrderCount === 0) {
    failures.push("historical_orders_missing_glt_custom_tag");
  }

  let linkedTradeCount = 0;
  for (const trade of trades) {
    if (!isPositiveInteger(trade.id)) {
      failures.push("historical_trade_id_invalid");
    }
    if (!isPositiveInteger(trade.orderId)) {
      failures.push("historical_trade_order_id_invalid");
    } else if (orderIds.has(trade.orderId)) {
      linkedTradeCount += 1;
    }
    if (typeof trade.contractId !== "string" || trade.contractId.length === 0) {
      failures.push("historical_trade_contract_id_invalid");
    }
  }
  if (linkedTradeCount === 0) {
    failures.push("historical_trades_missing_order_id_linkage");
  }

  return failures;
}
