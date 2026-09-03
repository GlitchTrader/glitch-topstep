import { createHash } from "node:crypto";
import { PathChronologyTracker, type PathChronologyTrackerSnapshot } from "./path-chronology-tracker.js";
import type {
  PathChronologyEvidenceQuality,
  PathChronologyV1,
} from "./trade-outcome.js";
import { PATH_CHRONOLOGY_SCHEMA } from "./trade-outcome.js";

export interface PathChronologyExcursionInput {
  mfe_usd: number | null;
  mae_usd: number | null;
  mfe_price?: number | null;
  mfe_utc?: string | null;
  mae_price?: number | null;
  mae_utc?: string | null;
  mfe_ticks?: number | null;
  mae_ticks?: number | null;
  same_event_gap?: boolean;
}

export interface PathChronologyBuildInput extends PathChronologyExcursionInput {
  tracker?: PathChronologyTrackerSnapshot | null;
}

export type PathChronologyEvidenceEventKind =
  | "price"
  | "amendment"
  | "partial_fill"
  | "partial_exit";

export interface PathChronologyEvidenceEvent {
  kind: PathChronologyEvidenceEventKind;
  utc: string;
  price?: number | null;
  bar_high?: number | null;
  bar_low?: number | null;
  stop_price?: number | null;
  target_price?: number | null;
  amendment_source?: string | null;
  filled_qty?: number;
  remaining_qty?: number;
}

export interface PathChronologyReplayInput {
  side: "long" | "short";
  entry_price: number;
  breakeven_price: number;
  initial_stop: number | null;
  initial_target: number | null;
  intent_id: string;
  entry_order_id: number | null;
  opened_utc: string;
  events: readonly PathChronologyEvidenceEvent[];
  excursion?: PathChronologyExcursionInput;
}

export function buildPathChronologyFromExcursion(
  input: PathChronologyExcursionInput,
): PathChronologyV1 | null {
  return buildPathChronology({ ...input });
}

export function buildPathChronology(input: PathChronologyBuildInput): PathChronologyV1 | null {
  const hasExcursion = input.mfe_usd !== null || input.mae_usd !== null;
  const hasTracker = input.tracker !== undefined && input.tracker !== null;
  if (!hasExcursion && !hasTracker) {
    return null;
  }

  const mfeComplete = hasExtremeEvidence(input.mfe_usd, input.mfe_price, input.mfe_utc);
  const maeComplete = hasExtremeEvidence(input.mae_usd, input.mae_price, input.mae_utc);
  const evidenceQuality = resolveEvidenceQuality(input, mfeComplete, maeComplete, input.tracker);
  const gaps = [...(input.tracker?.gaps ?? [])];
  if (input.same_event_gap) {
    gaps.push("same_event_gap");
  }

  const chronology: PathChronologyV1 = {
    schema_version: PATH_CHRONOLOGY_SCHEMA,
    mfe: {
      price: input.mfe_price ?? null,
      utc: input.mfe_utc ?? null,
      usd: input.mfe_usd,
      ticks: input.mfe_ticks ?? null,
    },
    mae: {
      price: input.mae_price ?? null,
      utc: input.mae_utc ?? null,
      usd: input.mae_usd,
      ticks: input.mae_ticks ?? null,
    },
    evidence_quality: evidenceQuality,
    ...(input.tracker ? {
      first_passage: input.tracker.firstPassage,
      amendment_intervals: input.tracker.amendmentIntervals,
      target_before_stop: input.tracker.targetBeforeStop,
      tranche: input.tracker.tranche,
    } : {}),
    ...(gaps.length > 0 ? { gaps: [...new Set(gaps)] } : {}),
  };
  chronology.chronology_hash = stablePathChronologyHash(chronology);
  return chronology;
}

export function rebuildPathChronologyFromEvidence(
  input: PathChronologyReplayInput,
): PathChronologyV1 {
  const tracker = new PathChronologyTracker();
  tracker.begin({
    intentId: input.intent_id,
    side: input.side,
    entryPrice: input.entry_price,
    breakevenPrice: input.breakeven_price,
    stopPrice: input.initial_stop,
    targetPrice: input.initial_target,
    entryOrderId: input.entry_order_id,
    filledQty: input.events.find((event) => event.kind === "partial_fill")?.filled_qty ?? 1,
    openedUtc: input.opened_utc,
  });
  for (const event of [...input.events].sort((left, right) => left.utc.localeCompare(right.utc))) {
    switch (event.kind) {
      case "price":
        tracker.observe({
          markPrice: event.price ?? null,
          observedUtc: event.utc,
          barHigh: event.bar_high ?? null,
          barLow: event.bar_low ?? null,
        });
        break;
      case "amendment":
        tracker.observeAmendment(
          event.stop_price ?? null,
          event.target_price ?? null,
          event.amendment_source ?? null,
          event.utc,
        );
        break;
      case "partial_fill":
        tracker.observePartialFill(
          event.filled_qty ?? 0,
          event.remaining_qty ?? 0,
        );
        break;
      case "partial_exit":
        tracker.observePartialExit(event.remaining_qty ?? 0);
        break;
      default:
        break;
    }
  }
  const built = buildPathChronology({
    ...(input.excursion ?? { mfe_usd: null, mae_usd: null }),
    tracker: tracker.snapshot(),
  });
  if (!built) {
    throw new Error("path_chronology_replay_empty");
  }
  return built;
}

export function stablePathChronologyHash(chronology: PathChronologyV1): string {
  const { chronology_hash: _ignored, ...body } = chronology;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function pathChronologyHashesMatch(
  live: PathChronologyV1,
  replay: PathChronologyV1,
): boolean {
  return stablePathChronologyHash(live) === stablePathChronologyHash(replay);
}

function hasExtremeEvidence(
  usd: number | null,
  price: number | null | undefined,
  utc: string | null | undefined,
): boolean {
  return usd !== null && price != null && utc != null && utc.length > 0;
}

function resolveEvidenceQuality(
  input: PathChronologyExcursionInput,
  mfeComplete: boolean,
  maeComplete: boolean,
  tracker?: PathChronologyTrackerSnapshot | null,
): PathChronologyEvidenceQuality {
  if (input.same_event_gap) {
    return "same_event_gap";
  }
  if (tracker?.gaps.includes("intra_bar_touch_ambiguous")) {
    return "unresolved";
  }
  const hasAnyUsd = input.mfe_usd !== null || input.mae_usd !== null;
  const hasTracker = tracker !== undefined && tracker !== null;
  if (!hasAnyUsd && !hasTracker) {
    return "unresolved";
  }
  if (mfeComplete && maeComplete && (!hasTracker || tracker.gaps.length === 0)) {
    return "complete";
  }
  if (!hasAnyUsd && hasTracker) {
    return tracker.gaps.length > 0 ? "partial" : "complete";
  }
  return "partial";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (Array.isArray(current)) {
      return current;
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      return Object.keys(record).sort().reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = record[key];
        return sorted;
      }, {});
    }
    return current;
  });
}
