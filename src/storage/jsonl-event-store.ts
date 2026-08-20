import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface LedgerEvent {
  schema_version: "glitch.direct.event.v1";
  event_id: string;
  recorded_utc: string;
  event: string;
  payload: unknown;
}

export interface EventLedgerStatus {
  pending: number;
  failed_writes: number;
  consecutive_failures: number;
  last_write_error: string | null;
  last_failure_utc: string | null;
  durable: boolean;
}

export class JsonlEventStore {
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();
  private pending = 0;
  private failedWrites = 0;
  private consecutiveFailures = 0;
  private lastWriteError: string | null = null;
  private lastFailureUtc: string | null = null;

  public constructor(dataDirectory: string, fileName = "events.jsonl") {
    this.path = resolve(dataDirectory, fileName);
  }

  public append(event: LedgerEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.pending += 1;
    const write = this.writeChain.then(() => this.writeLine(line));
    // The caller sees its own failure, the queue never does: a rejected chain would
    // otherwise stall or unhandled-reject every write scheduled behind it.
    this.writeChain = write.then(() => undefined, () => undefined);
    return write;
  }

  public async waitForIdle(): Promise<void> {
    await this.writeChain;
  }

  /** False while the last append failed: execution evidence is not provably on disk. */
  public isDurable(): boolean {
    return this.consecutiveFailures === 0;
  }

  public status(): EventLedgerStatus {
    return {
      pending: this.pending,
      failed_writes: this.failedWrites,
      consecutive_failures: this.consecutiveFailures,
      last_write_error: this.lastWriteError,
      last_failure_utc: this.lastFailureUtc,
      durable: this.isDurable(),
    };
  }

  private async writeLine(line: string): Promise<void> {
    let handle;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      handle = await open(this.path, "a", 0o600);
      await handle.writeFile(line, "utf8");
      await handle.sync();
      this.lastWriteError = null;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.failedWrites += 1;
      this.consecutiveFailures += 1;
      this.lastWriteError = error instanceof Error ? error.message : String(error);
      this.lastFailureUtc = new Date().toISOString();
      throw error;
    } finally {
      await handle?.close();
      this.pending -= 1;
    }
  }
}
