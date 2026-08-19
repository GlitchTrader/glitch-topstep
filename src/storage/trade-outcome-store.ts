import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";
import { SqliteOutcomeFeed, type OutcomeFeedStatus, type OutcomeRevisionPage } from "./sqlite-outcome-feed.js";

export class TradeOutcomeStore {
  private readonly path: string;
  private readonly mirrorPath?: string;
  private readonly known = new Map<string, TradeOutcomeV1>();
  private readonly pending = new Set<string>();
  private readonly feed: SqliteOutcomeFeed;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  private lastWriteError: string | null = null;

  public constructor(
    dataDirectory: string,
    fileName = "trade-outcomes.jsonl",
    mirrorPath?: string,
  ) {
    this.path = resolve(dataDirectory, fileName);
    this.mirrorPath = mirrorPath ? resolve(mirrorPath) : undefined;
    this.feed = new SqliteOutcomeFeed(resolve(dataDirectory, "trade-outcomes.sqlite"));
  }

  public async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.known.clear();
    const canonical = this.feed.current();
    if (canonical.length > 0) {
      for (const outcome of canonical) {
        this.known.set(outcome.intent_id, outcome);
      }
      return;
    }
    try {
      const text = await readFile(this.path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const row = JSON.parse(line) as TradeOutcomeV1;
        if (typeof row.intent_id === "string") {
          this.known.set(row.intent_id, row);
          this.feed.publish(row, "enriched", row.exit_utc);
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

  public all(): TradeOutcomeV1[] {
    return [...this.known.values()];
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public append(outcome: TradeOutcomeV1): Promise<void> {
    if (this.known.has(outcome.intent_id) || this.pending.has(outcome.intent_id)) {
      return Promise.resolve();
    }
    this.pending.add(outcome.intent_id);
    const line = `${JSON.stringify(outcome)}\n`;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      try {
        this.feed.publish(outcome, outcome.learning_eligible ? "enriched" : "provisional");
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: "utf8" });
        if (this.mirrorPath) {
          await mkdir(dirname(this.mirrorPath), { recursive: true });
          await appendFile(this.mirrorPath, line, { encoding: "utf8" });
        }
        this.known.set(outcome.intent_id, outcome);
        this.lastWriteError = null;
      } catch (error) {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.pending.delete(outcome.intent_id);
      }
    });
    return this.writeChain;
  }

  public replace(outcome: TradeOutcomeV1): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      try {
        this.feed.publish(outcome, "corrected");
        await this.rewriteFiles(new Map(this.known).set(outcome.intent_id, outcome));
        this.known.set(outcome.intent_id, outcome);
        this.lastWriteError = null;
      } catch (error) {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    return this.writeChain;
  }

  public revisionPage(afterSequence: number, limit: number): OutcomeRevisionPage {
    return this.feed.afterSequence(afterSequence, limit);
  }

  public status(): { pending: number; last_write_error: string | null; feed: OutcomeFeedStatus } {
    return { pending: this.pending.size, last_write_error: this.lastWriteError, feed: this.feed.status() };
  }

  public async close(): Promise<void> {
    await this.waitForIdle();
    this.feed.close();
  }

  public async waitForIdle(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  public async recent(limit: number): Promise<TradeOutcomeV1[]> {
    await this.load();
    return [...this.known.values()].slice(-limit);
  }

  private async rewriteFiles(source = this.known): Promise<void> {
    const body = [...source.values()].map((row) => JSON.stringify(row)).join("\n");
    const text = body.length > 0 ? `${body}\n` : "";
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, text, { encoding: "utf8" });
    if (this.mirrorPath) {
      await mkdir(dirname(this.mirrorPath), { recursive: true });
      await writeFile(this.mirrorPath, text, { encoding: "utf8" });
    }
  }
}
