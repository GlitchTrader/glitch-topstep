import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";

export class TradeOutcomeStore {
  private readonly path: string;
  private readonly mirrorPath?: string;
  private readonly known = new Map<string, TradeOutcomeV1>();
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
    this.known.clear();
    try {
      const text = await readFile(this.path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const row = JSON.parse(line) as TradeOutcomeV1;
        if (typeof row.intent_id === "string") {
          this.known.set(row.intent_id, row);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  public hasIntent(intentId: string): boolean {
    return this.known.has(intentId);
  }

  public get(intentId: string): TradeOutcomeV1 | undefined {
    return this.known.get(intentId);
  }

  public append(outcome: TradeOutcomeV1): Promise<void> {
    if (this.known.has(outcome.intent_id)) {
      return Promise.resolve();
    }
    this.known.set(outcome.intent_id, outcome);
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

  public replace(outcome: TradeOutcomeV1): Promise<void> {
    this.known.set(outcome.intent_id, outcome);
    this.writeChain = this.writeChain.then(async () => {
      await this.rewriteFiles();
    });
    return this.writeChain;
  }

  public async recent(limit: number): Promise<TradeOutcomeV1[]> {
    await this.load();
    return [...this.known.values()].slice(-limit);
  }

  private async rewriteFiles(): Promise<void> {
    const body = [...this.known.values()].map((row) => JSON.stringify(row)).join("\n");
    const text = body.length > 0 ? `${body}\n` : "";
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, text, { encoding: "utf8" });
    if (this.mirrorPath) {
      await mkdir(dirname(this.mirrorPath), { recursive: true });
      await writeFile(this.mirrorPath, text, { encoding: "utf8" });
    }
  }
}
