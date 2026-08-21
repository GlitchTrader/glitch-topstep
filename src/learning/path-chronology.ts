import type { PathChronologyEvidenceQuality, PathChronologyV1 } from "./trade-outcome.js";
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

export function buildPathChronologyFromExcursion(
  input: PathChronologyExcursionInput,
): PathChronologyV1 | null {
  if (input.mfe_usd === null && input.mae_usd === null) {
    return null;
  }

  const mfeComplete = hasExtremeEvidence(input.mfe_usd, input.mfe_price, input.mfe_utc);
  const maeComplete = hasExtremeEvidence(input.mae_usd, input.mae_price, input.mae_utc);
  const evidenceQuality = resolveEvidenceQuality(input, mfeComplete, maeComplete);

  return {
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
  };
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
): PathChronologyEvidenceQuality {
  if (input.same_event_gap) {
    return "same_event_gap";
  }
  const hasAnyUsd = input.mfe_usd !== null || input.mae_usd !== null;
  if (!hasAnyUsd) {
    return "unresolved";
  }
  if (mfeComplete && maeComplete) {
    return "complete";
  }
  if (input.mfe_usd === null || input.mae_usd === null) {
    return "partial";
  }
  return "partial";
}
