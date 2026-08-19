import { PROJECTX_MARKET_STREAM_EVENT_TYPES } from "./stream-subscriptions.js";

export const EVENT_RATES_PROOF_SCHEMA = "glitch.projectx.event_rates_proof.v1" as const;

export const MARKET_RATE_EVENT_TYPES = PROJECTX_MARKET_STREAM_EVENT_TYPES;

export type MarketRateEventType = (typeof MARKET_RATE_EVENT_TYPES)[number];

export interface EventRatesMinuteBucket {
  minute_utc: string;
  quote: number;
  market_trade: number;
  depth: number;
  market_event_total: number;
}

export interface EventRatesProof {
  schema_version: typeof EVENT_RATES_PROOF_SCHEMA;
  captured_utc: string;
  mode: "retrospective" | "live_poll";
  scope: {
    account_id: number;
    account_name: string;
    contract_id: string;
    instrument: string;
  };
  observation: {
    window_start_utc: string;
    window_end_utc: string;
    duration_minutes: number;
  };
  retention_policy: {
    market_event_retention: number;
    market_prune_interval: number;
    maximum_market_events_between_prunes: number;
  };
  stream_rates_per_second: Record<MarketRateEventType, number>;
  event_totals: Record<MarketRateEventType, number>;
  minute_buckets: EventRatesMinuteBucket[];
  disk: {
    evidence_db_bytes_start: number;
    evidence_db_bytes_end: number;
    evidence_db_bytes_delta: number;
    event_count_start: number;
    event_count_end: number;
    event_count_delta: number;
    bytes_per_event: number | null;
    sequence_start?: number | null;
    sequence_end?: number | null;
    sequence_delta?: number | null;
    retained_count_delta?: number;
    pruning_observed?: boolean;
  };
  retention_observed: {
    peak_market_event_count: number;
    within_policy: boolean;
  };
  proof_passed: boolean;
  proof_failures: string[];
}

export interface MarketEventCountRow {
  event_type: string;
  count: number;
}

export interface MarketMinuteRow {
  minute_utc: string;
  event_type: string;
  count: number;
}

export function totalsFromRows(rows: MarketEventCountRow[]): Record<MarketRateEventType, number> {
  const totals: Record<MarketRateEventType, number> = {
    quote: 0,
    market_trade: 0,
    depth: 0,
  };
  for (const row of rows) {
    if (row.event_type in totals) {
      totals[row.event_type as MarketRateEventType] = row.count;
    }
  }
  return totals;
}

export function buildMinuteBuckets(rows: MarketMinuteRow[]): EventRatesMinuteBucket[] {
  const byMinute = new Map<string, EventRatesMinuteBucket>();
  for (const row of rows) {
    let bucket = byMinute.get(row.minute_utc);
    if (!bucket) {
      bucket = {
        minute_utc: row.minute_utc,
        quote: 0,
        market_trade: 0,
        depth: 0,
        market_event_total: 0,
      };
      byMinute.set(row.minute_utc, bucket);
    }
    if (row.event_type === "quote") {
      bucket.quote = row.count;
    } else if (row.event_type === "market_trade") {
      bucket.market_trade = row.count;
    } else if (row.event_type === "depth") {
      bucket.depth = row.count;
    }
    bucket.market_event_total = bucket.quote + bucket.market_trade + bucket.depth;
  }
  return [...byMinute.values()].sort((left, right) => left.minute_utc.localeCompare(right.minute_utc));
}

export function ratesPerSecond(
  totals: Record<MarketRateEventType, number>,
  durationMinutes: number,
): Record<MarketRateEventType, number> {
  const seconds = Math.max(durationMinutes * 60, 1);
  return {
    quote: totals.quote / seconds,
    market_trade: totals.market_trade / seconds,
    depth: totals.depth / seconds,
  };
}

export function buildEventRatesProof(input: {
  capturedUtc: string;
  mode: EventRatesProof["mode"];
  scope: EventRatesProof["scope"];
  windowStartUtc: string;
  windowEndUtc: string;
  durationMinutes: number;
  retentionPolicy: EventRatesProof["retention_policy"];
  eventTotals: Record<MarketRateEventType, number>;
  minuteBuckets: EventRatesMinuteBucket[];
  diskBytesStart: number;
  diskBytesEnd: number;
  eventCountStart: number;
  eventCountEnd: number;
  latestSequenceStart?: number | null;
  latestSequenceEnd?: number | null;
  peakMarketEventCount: number;
  minimumDurationMinutes?: number;
}): EventRatesProof {
  const failures = validateEventRatesProofInput(input);
  const durationMinutes = input.durationMinutes;
  const eventCountDelta = input.eventCountEnd - input.eventCountStart;
  const sequenceDelta = input.latestSequenceStart !== null
    && input.latestSequenceStart !== undefined
    && input.latestSequenceEnd !== null
    && input.latestSequenceEnd !== undefined
    ? input.latestSequenceEnd - input.latestSequenceStart
    : null;
  const durableEventDelta = sequenceDelta ?? eventCountDelta;
  const diskDelta = input.diskBytesEnd - input.diskBytesStart;
  const bytesPerEvent = durableEventDelta > 0 ? diskDelta / durableEventDelta : null;
  return {
    schema_version: EVENT_RATES_PROOF_SCHEMA,
    captured_utc: input.capturedUtc,
    mode: input.mode,
    scope: input.scope,
    observation: {
      window_start_utc: input.windowStartUtc,
      window_end_utc: input.windowEndUtc,
      duration_minutes: durationMinutes,
    },
    retention_policy: input.retentionPolicy,
    stream_rates_per_second: ratesPerSecond(input.eventTotals, durationMinutes),
    event_totals: input.eventTotals,
    minute_buckets: input.minuteBuckets,
    disk: {
      evidence_db_bytes_start: input.diskBytesStart,
      evidence_db_bytes_end: input.diskBytesEnd,
      evidence_db_bytes_delta: diskDelta,
      event_count_start: input.eventCountStart,
      event_count_end: input.eventCountEnd,
      event_count_delta: eventCountDelta,
      bytes_per_event: bytesPerEvent,
      sequence_start: input.latestSequenceStart ?? null,
      sequence_end: input.latestSequenceEnd ?? null,
      sequence_delta: sequenceDelta,
      retained_count_delta: eventCountDelta,
      pruning_observed: eventCountDelta < 0,
    },
    retention_observed: {
      peak_market_event_count: input.peakMarketEventCount,
      within_policy: input.peakMarketEventCount <= input.retentionPolicy.maximum_market_events_between_prunes,
    },
    proof_passed: failures.length === 0,
    proof_failures: failures,
  };
}

export function validateEventRatesProof(proof: EventRatesProof): string[] {
  if (proof.schema_version !== EVENT_RATES_PROOF_SCHEMA) {
    return ["schema_version_invalid"];
  }
  if (!proof.proof_passed) {
    return [...proof.proof_failures];
  }
  return validateEventRatesProofInput({
    windowStartUtc: proof.observation.window_start_utc,
    windowEndUtc: proof.observation.window_end_utc,
    durationMinutes: proof.observation.duration_minutes,
    retentionPolicy: proof.retention_policy,
    eventTotals: proof.event_totals,
    minuteBuckets: proof.minute_buckets,
    diskBytesStart: proof.disk.evidence_db_bytes_start,
    diskBytesEnd: proof.disk.evidence_db_bytes_end,
    eventCountStart: proof.disk.event_count_start,
    eventCountEnd: proof.disk.event_count_end,
    latestSequenceStart: proof.disk.sequence_start,
    latestSequenceEnd: proof.disk.sequence_end,
    peakMarketEventCount: proof.retention_observed.peak_market_event_count,
    minimumDurationMinutes: 30,
  });
}

function validateEventRatesProofInput(input: {
  windowStartUtc: string;
  windowEndUtc: string;
  durationMinutes: number;
  retentionPolicy: EventRatesProof["retention_policy"];
  eventTotals: Record<MarketRateEventType, number>;
  minuteBuckets: EventRatesMinuteBucket[];
  diskBytesStart: number;
  diskBytesEnd: number;
  eventCountStart: number;
  eventCountEnd: number;
  latestSequenceStart?: number | null;
  latestSequenceEnd?: number | null;
  peakMarketEventCount: number;
  minimumDurationMinutes?: number;
}): string[] {
  const failures: string[] = [];
  const minimumDuration = input.minimumDurationMinutes ?? 30;
  if (input.durationMinutes < minimumDuration) {
    failures.push("observation_window_too_short");
  }
  if (Date.parse(input.windowEndUtc) <= Date.parse(input.windowStartUtc)) {
    failures.push("observation_window_invalid");
  }
  for (const eventType of MARKET_RATE_EVENT_TYPES) {
    if (input.eventTotals[eventType] <= 0) {
      failures.push(`stream_rate_missing:${eventType}`);
    }
  }
  if (input.minuteBuckets.length < Math.max(1, minimumDuration - 1)) {
    failures.push("minute_buckets_incomplete");
  }
  if (input.peakMarketEventCount > input.retentionPolicy.maximum_market_events_between_prunes) {
    failures.push("market_event_retention_exceeded");
  }
  if (input.diskBytesEnd < input.diskBytesStart) {
    failures.push("evidence_db_shrank_unexpectedly");
  }
  if (input.latestSequenceStart !== null && input.latestSequenceStart !== undefined
    && input.latestSequenceEnd !== null && input.latestSequenceEnd !== undefined
    && input.latestSequenceEnd < input.latestSequenceStart) {
    failures.push("provider_sequence_regressed_during_disk_sample");
  } else if ((input.latestSequenceStart === null || input.latestSequenceStart === undefined)
    && (input.latestSequenceEnd === null || input.latestSequenceEnd === undefined)
    && input.eventCountEnd < input.eventCountStart) {
    failures.push("event_count_regressed_during_disk_sample");
  }
  return failures;
}
