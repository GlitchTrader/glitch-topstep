import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface LedgerEvent {
  schema_version: "glitch.direct.event.v1";
  event_id: string;
  recorded_utc: string;
  event: string;
  payload: unknown;
}

export class JsonlEventStore {
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastWriteError: string | null = null;

  public constructor(dataDirectory: string, fileName = "events.jsonl") {
    this.path = resolve(dataDirectory, fileName);
  }

  public append(event: LedgerEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.pending += 1;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      let handle;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        handle = await open(this.path, "a", 0o600);
        await handle.writeFile(line, "utf8");
        await handle.sync();
        this.lastWriteError = null;
      } catch (error) {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        await handle?.close();
        this.pending -= 1;
      }
    });
    return this.writeChain;
  }

  public async waitForIdle(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  public status(): { pending: number; last_write_error: string | null } {
    return { pending: this.pending, last_write_error: this.lastWriteError };
  }
}
