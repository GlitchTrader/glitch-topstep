import type { TradeOutcomeV1 } from "../../learning/trade-outcome.js";

export type OutcomeRevisionStatus = "provisional" | "enriched" | "corrected";

export interface OutcomeRevision {
  sequence: number;
  outcome_id: string;
  intent_id: string;
  revision: number;
  status: OutcomeRevisionStatus;
  content_hash: string;
  recorded_utc: string;
  outcome: TradeOutcomeV1;
}

export interface OutcomeRevisionPage {
  schema_version: "glitch.topstep.outcome_feed.v2";
  retention_floor_sequence: number;
  high_water_sequence: number;
  after_sequence: number;
  count: number;
  revisions: OutcomeRevision[];
}

export interface OutcomeFeedStatus {
  current_count: number;
  revision_count: number;
  high_water_sequence: number;
  integrity: "ok" | "failed";
  integrity_error: string | null;
}

export interface OutcomeFeedPort {
  publish(
    outcome: TradeOutcomeV1,
    status: OutcomeRevisionStatus,
    recordedUtc?: string,
  ): OutcomeRevision;
  current(): TradeOutcomeV1[];
  afterSequence(afterSequence: number, limit?: number): OutcomeRevisionPage;
  status(): OutcomeFeedStatus;
}
