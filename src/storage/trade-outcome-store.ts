import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";

export class TradeOutcomeStore {
  private readonly path: string;
  private readonly mirrorPath?: string;
  private readonly knownIntentIds = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  public constructor(
    dataDirectory: string,
    fileName = "trade-outcomes.jsonl",
    mirrorPath?: string,
  ) {
    this.path = resolve(dataDirectory, fileName);
    this.mirrorPath = mirrorPath ? resolve(mirrorPath) : undefined;
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const text = await readFile(this.path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const row = JSON.parse(line) as TradeOutcomeV1;
        if (typeof row.intent_id === "string") {
          this.knownIntentIds.add(row.intent_id);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  public hasIntent(intentId: string): boolean {
    return this.knownIntentIds.has(intentId);
  }

  public append(outcome: TradeOutcomeV1): Promise<void> {
    if (this.knownIntentIds.has(outcome.intent_id)) {
      return Promise.resolve();
    }
    this.knownIntentIds.add(outcome.intent_id);
    const line = `${JSON.stringify(outcome)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { encoding: "utf8" });
      if (this.mirrorPath) {
        await mkdir(dirname(this.mirrorPath), { recursive: true });
        await appendFile(this.mirrorPath, line, { encoding: "utf8" });
      }
    });
    return this.writeChain;
  }

  public async recent(limit: number): Promise<TradeOutcomeV1[]> {
    await this.load();
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const rows: TradeOutcomeV1[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      rows.push(JSON.parse(line) as TradeOutcomeV1);
    }
    return rows.slice(-limit);
  }
}
