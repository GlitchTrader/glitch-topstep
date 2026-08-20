export interface LedgerEvent {
  schema_version: "glitch.direct.event.v1";
  event_id: string;
  recorded_utc: string;
  event: string;
  payload: unknown;
}

export interface ExecutionLedgerStatus {
  pending: number;
  failed_writes: number;
  consecutive_failures: number;
  last_write_error: string | null;
  last_failure_utc: string | null;
  durable: boolean;
}

export interface ExecutionLedgerPort {
  append(event: LedgerEvent): Promise<void>;
  isDurable(): boolean;
  status(): ExecutionLedgerStatus;
}
