import { DatabaseSync } from "node:sqlite";
import type { ProjectXOrderFlowState } from "../domain/order-flow.js";
import type { StoredProviderEvidenceEvent } from "../domain/provider-evidence.js";
import { buildProjectXOrderFlowObservation } from "./order-flow.js";

interface EvidenceRow {
  sequence: number | bigint;
  received_utc: string;
  provider_timestamp_utc: string | null;
  source: string;
  event_type: string;
  generation: number | bigint;
  account_id: number | bigint | null;
  contract_id: string | null;
  provider_entity_id: string | null;
  related_provider_entity_id: string | null;
  payload_hash: string;
  raw_payload_json: string;
  normalized_payload_json: string;
}

export interface ProjectXOrderFlowServiceOptions {
  contractId: string;
  tickSize: number;
  maxEvents: number;
  depthLevels: number;
  lookbackSeconds?: number;
}

export class ProjectXOrderFlowService {
  private readonly database: DatabaseSync;
  private readonly lookbackSeconds: number;
  private state: ProjectXOrderFlowState = {
    last_attempt_utc: null,
    last_succeeded_utc: null,
    last_error: null,
    observation: null,
  };
  private inFlight: Promise<ProjectXOrderFlowState> | null = null;

  public constructor(
    evidenceDatabasePath: string,
    private readonly options: ProjectXOrderFlowServiceOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isFinite(options.tickSize) || options.tickSize <= 0) {
      throw new Error("order_flow_tick_size_invalid");
    }
    if (!Number.isInteger(options.maxEvents) || options.maxEvents < 1_000 || options.maxEvents > 1_000_000) {
      throw new Error("order_flow_max_events_invalid");
    }
    if (!Number.isInteger(options.depthLevels) || options.depthLevels < 1 || options.depthLevels > 100) {
      throw new Error("order_flow_depth_levels_invalid");
    }
    this.lookbackSeconds = options.lookbackSeconds ?? 300;
    if (!Number.isInteger(this.lookbackSeconds) || this.lookbackSeconds < 300 || this.lookbackSeconds > 3_600) {
      throw new Error("order_flow_lookback_invalid");
    }
    this.database = new DatabaseSync(evidenceDatabasePath);
    this.database.exec("PRAGMA query_only=ON");
    this.database.exec("PRAGMA busy_timeout=5000");
  }

  public close(): void {
    this.database.close();
  }

  public current(): ProjectXOrderFlowState {
    return structuredClone(this.state);
  }

  public refresh(): Promise<ProjectXOrderFlowState> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.run();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    return run;
  }

  public async waitForIdle(): Promise<void> {
    if (!this.inFlight) {
      return;
    }
    await this.inFlight.then(
      () => undefined,
      () => undefined,
    );
  }

  private async run(): Promise<ProjectXOrderFlowState> {
    const generatedAt = this.now();
    const attemptedUtc = generatedAt.toISOString();
    this.state = {
      ...this.state,
      last_attempt_utc: attemptedUtc,
    };
    try {
      const lookbackStartUtc = new Date(
        generatedAt.getTime() - this.lookbackSeconds * 1_000,
      ).toISOString();
      const rows = this.database.prepare(`
        SELECT
          sequence,
          received_utc,
          provider_timestamp_utc,
          source,
          event_type,
          generation,
          account_id,
          contract_id,
          provider_entity_id,
          related_provider_entity_id,
          payload_hash,
          raw_payload_json,
          normalized_payload_json
        FROM provider_events
        WHERE source = 'projectx_market_stream'
          AND contract_id = ?
          AND event_type IN ('market_trade', 'depth')
          AND received_utc >= ?
        ORDER BY sequence ASC
        LIMIT ?
      `).all(
        this.options.contractId,
        lookbackStartUtc,
        this.options.maxEvents + 1,
      ) as unknown as EvidenceRow[];
      const truncated = rows.length > this.options.maxEvents;
      const selected = truncated ? rows.slice(0, this.options.maxEvents) : rows;
      const coverage = this.database.prepare(`
        SELECT MIN(received_utc) AS earliest_received_utc
        FROM provider_events
        WHERE source = 'projectx_market_stream'
          AND contract_id = ?
      `).get(this.options.contractId) as {
        earliest_received_utc: string | null;
      };
      const events = selected.map(fromRow);
      this.state = {
        last_attempt_utc: attemptedUtc,
        last_succeeded_utc: attemptedUtc,
        last_error: null,
        observation: buildProjectXOrderFlowObservation({
          events,
          contractId: this.options.contractId,
          tickSize: this.options.tickSize,
          generatedAt,
          truncated,
          coverageStartUtc: coverage.earliest_received_utc,
          depthLevels: this.options.depthLevels,
        }),
      };
    } catch (error) {
      this.state = {
        ...this.state,
        last_error: error instanceof Error ? `${error.name}:${error.message}` : String(error),
      };
    }
    return this.current();
  }
}

function fromRow(row: EvidenceRow): StoredProviderEvidenceEvent {
  return {
    sequence: Number(row.sequence),
    receivedUtc: row.received_utc,
    providerTimestampUtc: row.provider_timestamp_utc,
    source: row.source as StoredProviderEvidenceEvent["source"],
    eventType: row.event_type,
    generation: Number(row.generation),
    accountId: row.account_id === null ? null : Number(row.account_id),
    contractId: row.contract_id,
    providerEntityId: row.provider_entity_id,
    relatedProviderEntityId: row.related_provider_entity_id,
    payloadHash: row.payload_hash,
    rawPayload: JSON.parse(row.raw_payload_json) as unknown,
    normalizedPayload: JSON.parse(row.normalized_payload_json) as unknown,
  };
}
