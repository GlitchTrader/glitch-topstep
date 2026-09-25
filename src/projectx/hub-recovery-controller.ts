import type { VenueStreamKind } from "../domain/models.js";

export type HubRecoveryPhase =
  | "connected"
  | "suspect"
  | "reconnecting"
  | "resubscribing"
  | "reconciling"
  | "recovered"
  | "failed";

export interface HubRecoverySnapshot {
  active: boolean;
  kind: VenueStreamKind | null;
  phase: HubRecoveryPhase;
  started_at: string | null;
  last_progress_at: string | null;
  attempt: number;
  deadline_at: string | null;
  generation: number;
}

export const DEFAULT_HUB_RECOVERY_DEADLINE_MS = 120_000;

export function idleHubRecoverySnapshot(): HubRecoverySnapshot {
  return {
    active: false,
    kind: null,
    phase: "connected",
    started_at: null,
    last_progress_at: null,
    attempt: 0,
    deadline_at: null,
    generation: 0,
  };
}

const ACTIVE_PHASES: ReadonlySet<HubRecoveryPhase> = new Set([
  "suspect",
  "reconnecting",
  "resubscribing",
  "reconciling",
]);

export class HubRecoveryController {
  private phase: HubRecoveryPhase = "connected";
  private kind: VenueStreamKind | null = null;
  private startedAt: string | null = null;
  private lastProgressAt: string | null = null;
  private attempt = 0;
  private deadlineAt: string | null = null;
  private recoveryGeneration = 0;

  public constructor(private readonly deadlineMs = DEFAULT_HUB_RECOVERY_DEADLINE_MS) {}

  public snapshot(): HubRecoverySnapshot {
    return {
      active: ACTIVE_PHASES.has(this.phase),
      kind: this.kind,
      phase: this.phase,
      started_at: this.startedAt,
      last_progress_at: this.lastProgressAt,
      attempt: this.attempt,
      deadline_at: this.deadlineAt,
      generation: this.recoveryGeneration,
    };
  }

  /**
   * Starts a recovery attempt; returns generation for stale-callback guards.
   * ponytail: while already in an active phase, keep the current generation.
   * Bumping it here makes isStaleCallback abort the in-flight pipeline and
   * retrigger history_sync (TS-STREAM-RECOVERY-01 soak 2026-09-24).
   * Ceiling: same-gen onReconnected can still enqueue another pipeline;
   * items 2/3 (shared pipeline / starve history) are the upgrade.
   */
  public beginAttempt(kind: VenueStreamKind, phase: HubRecoveryPhase, atUtc: string): number {
    if (ACTIVE_PHASES.has(this.phase)) {
      this.attempt += 1;
      this.lastProgressAt = atUtc;
      return this.recoveryGeneration;
    }
    this.recoveryGeneration += 1;
    this.attempt += 1;
    this.kind = kind;
    this.phase = phase;
    this.startedAt = atUtc;
    this.lastProgressAt = atUtc;
    this.deadlineAt = new Date(Date.parse(atUtc) + this.deadlineMs).toISOString();
    return this.recoveryGeneration;
  }

  public markProgress(
    phase: HubRecoveryPhase,
    expectedGeneration: number,
    atUtc: string,
  ): boolean {
    if (this.isStaleCallback(expectedGeneration)) {
      return false;
    }
    this.phase = phase;
    this.lastProgressAt = atUtc;
    return true;
  }

  public complete(expectedGeneration: number, atUtc: string): boolean {
    if (this.isStaleCallback(expectedGeneration)) {
      return false;
    }
    this.phase = "recovered";
    this.lastProgressAt = atUtc;
    this.kind = null;
    this.startedAt = null;
    this.deadlineAt = null;
    this.phase = "connected";
    return true;
  }

  public fail(expectedGeneration: number, atUtc: string): boolean {
    if (this.isStaleCallback(expectedGeneration)) {
      return false;
    }
    this.phase = "failed";
    this.lastProgressAt = atUtc;
    return true;
  }

  public isStaleCallback(generation: number): boolean {
    return generation !== this.recoveryGeneration;
  }

  public deadlineExpired(nowMs = Date.now()): boolean {
    if (!this.deadlineAt) {
      return false;
    }
    return nowMs >= Date.parse(this.deadlineAt);
  }
}
