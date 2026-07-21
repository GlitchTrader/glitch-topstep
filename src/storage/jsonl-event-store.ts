import { appendFile, mkdir } from "node:fs/promises";
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

  public constructor(dataDirectory: string, fileName = "events.jsonl") {
    this.path = resolve(dataDirectory, fileName);
  }

  public append(event: LedgerEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { encoding: "utf8" });
    });
    return this.writeChain;
  }
}
