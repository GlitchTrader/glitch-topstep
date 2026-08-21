import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TradeOutcomeV1 } from "../learning/trade-outcome.js";

/** ponytail: hot cache only; SQLite feed remains authoritative (TS-REAUDIT-05). */
const MAX_HOT_OUTCOMES = 2_048;
import { quarantineCorruptTail, writeFileAtomic, type QuarantineRecord } from "./atomic-file.js";
import { SqliteOutcomeFeed, type OutcomeFeedStatus, type OutcomeRevisionPage } from "./sqlite-outcome-feed.js";

export interface TradeOutcomeStoreStatus {
  pending: number;
  last_write_error: string | null;
  export_backlog: number;
  export_failures: number;
  last_export_error: string | null;
  quarantine: QuarantineRecord | null;
  feed: OutcomeFeedStatus;
}

export class TradeOutcomeStore {
  private readonly path: string;
  private readonly mirrorPath?: string;
  private readonly known = new Map<string, TradeOutcomeV1>();
  private readonly pending = new Set<string>();
  private readonly feed: SqliteOutcomeFeed;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  private lastWriteError: string | null = null;
  private exportBacklog = 0;
  private exportFailures = 0;
  private lastExportError: string | null = null;
  private quarantine: QuarantineRecord | null = null;

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
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) {
        continue;
      }
      let row: TradeOutcomeV1;
      try {
        row = JSON.parse(line) as TradeOutcomeV1;
      } catch (error) {
        // A torn tail is evidence, not noise: park it and keep the readable prefix.
        this.quarantine = await quarantineCorruptTail(
          this.path,
          joinLines(lines.slice(0, index)),
          joinLines(lines.slice(index)),
          `outcome_export_parse_failed_line_${index + 1}:${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (typeof row.intent_id === "string") {
        this.known.set(row.intent_id, row);
        this.feed.publish(row, "enriched", row.exit_utc);
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
    return this.schedule(async () => {
      this.commit(outcome, outcome.learning_eligible ? "enriched" : "provisional", () => {
        this.pending.delete(outcome.intent_id);
      });
      await this.syncExport(outcome);
    });
  }

  public replace(outcome: TradeOutcomeV1): Promise<void> {
    return this.schedule(async () => {
      this.commit(outcome, "corrected");
      await this.syncExport(null);
    });
  }

  public revisionPage(afterSequence: number, limit: number): OutcomeRevisionPage {
    return this.feed.afterSequence(afterSequence, limit);
  }

  public status(): TradeOutcomeStoreStatus {
    return {
      pending: this.pending.size,
      last_write_error: this.lastWriteError,
      export_backlog: this.exportBacklog,
      export_failures: this.exportFailures,
      last_export_error: this.lastExportError,
      quarantine: this.quarantine,
      feed: this.feed.status(),
    };
  }

  public async close(): Promise<void> {
    await this.waitForIdle();
    this.feed.close();
  }

  public async waitForIdle(): Promise<void> {
    await this.writeChain;
  }

  public async recent(limit: number): Promise<TradeOutcomeV1[]> {
    await this.load();
    return [...this.known.values()].slice(-limit);
  }

  private schedule(work: () => Promise<void>): Promise<void> {
    const write = this.writeChain.then(work);
    // One failed write must not poison the writes queued behind it.
    this.writeChain = write.then(() => undefined, () => undefined);
    return write;
  }

  /** SQLite is authoritative, so the in-memory index only moves after that transaction commits. */
  private commit(
    outcome: TradeOutcomeV1,
    status: "provisional" | "enriched" | "corrected",
    onSettled: () => void = () => {},
  ): void {
    try {
      this.feed.publish(outcome, status);
      this.known.set(outcome.intent_id, outcome);
      if (this.known.size > MAX_HOT_OUTCOMES) {
        const overflow = this.known.size - MAX_HOT_OUTCOMES;
        for (const intentId of [...this.known.keys()].slice(0, overflow)) {
          this.known.delete(intentId);
        }
      }
      this.lastWriteError = null;
    } catch (error) {
      this.lastWriteError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      onSettled();
    }
  }

  /**
   * The JSONL files mirror committed state. A failed mirror write becomes visible backlog
   * that the next write heals with a full rewrite; it never rolls back the authoritative commit.
   */
  private async syncExport(appended: TradeOutcomeV1 | null): Promise<void> {
    try {
      if (appended && this.exportBacklog === 0) {
        const line = `${JSON.stringify(appended)}\n`;
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: "utf8" });
        if (this.mirrorPath) {
          await mkdir(dirname(this.mirrorPath), { recursive: true });
          await appendFile(this.mirrorPath, line, { encoding: "utf8" });
        }
      } else {
        await this.rewriteFiles();
      }
      this.exportBacklog = 0;
      this.lastExportError = null;
    } catch (error) {
      this.exportBacklog += 1;
      this.exportFailures += 1;
      this.lastExportError = error instanceof Error ? error.message : String(error);
    }
  }

  private async rewriteFiles(): Promise<void> {
    const body = [...this.known.values()].map((row) => JSON.stringify(row)).join("\n");
    const text = body.length > 0 ? `${body}\n` : "";
    await writeFileAtomic(this.path, text);
    if (this.mirrorPath) {
      await writeFileAtomic(this.mirrorPath, text);
    }
  }
}

function joinLines(lines: string[]): string {
  const body = lines.filter((line) => line.trim().length > 0).join("\n");
  return body.length > 0 ? `${body}\n` : "";
}
