import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { ProviderEvidenceEvent } from "../src/domain/provider-evidence.js";
import { EvidenceWriteQueue } from "../src/projectx/evidence-write-queue.js";
import { recordProviderEventBeforeApply } from "../src/projectx/provider-event-recorder.js";
import type { EventRatesProof } from "../src/projectx/event-rates-proof.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RATES_FIXTURE = path.join(ROOT, "tests", "fixtures", "projectx", "live", "event_rates_proof.json");
const BURST_MULTIPLIER = 5;
const BURST_SECONDS = 10;
const CONTRACTS = ["CON.F.US.MNQ.U26", "CON.F.US.MES.U26"] as const;

class RecordingWriter {
  public readonly written: ProviderEvidenceEvent[] = [];
  public readonly batchSizes: number[] = [];
  public failuresRemaining = 0;
  private sequence = 0;

  public appendBatch(events: readonly ProviderEvidenceEvent[]): readonly { sequence: number }[] {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("disk unavailable");
    }
    this.batchSizes.push(events.length);
    return events.map((event) => {
      this.written.push(event);
      this.sequence += 1;
      return { sequence: this.sequence };
    });
  }
}

function marketEvent(
  eventType: "quote" | "depth" | "market_trade",
  contractId: string,
  index: number,
  extra: Record<string, unknown> = {},
): ProviderEvidenceEvent {
  return {
    receivedUtc: new Date(Date.UTC(2026, 7, 20, 15, 30, 0, 0) + index).toISOString(),
    providerTimestampUtc: null,
    source: "projectx_market_stream",
    eventType,
    generation: 7,
    accountId: null,
    contractId,
    providerEntityId: `${contractId}:${index}`,
    rawPayload: { index },
    normalizedPayload: { contractId, index, ...extra },
  };
}

function identityEvent(eventType: string, index: number): ProviderEvidenceEvent {
  return {
    receivedUtc: new Date(Date.UTC(2026, 7, 20, 15, 30, 0, 0) + index).toISOString(),
    providerTimestampUtc: null,
    source: "projectx_user_stream",
    eventType,
    generation: 7,
    accountId: 26_282_486,
    contractId: CONTRACTS[0],
    providerEntityId: String(index),
    rawPayload: { index },
    normalizedPayload: { index },
  };
}

/** Interleaves market and user evidence at BURST_MULTIPLIER times the TS-R2-07 observed rates. */
function burstEvents(): ProviderEvidenceEvent[] {
  const proof = JSON.parse(fs.readFileSync(RATES_FIXTURE, "utf8")) as EventRatesProof;
  const rates = proof.stream_rates_per_second;
  const perSecond = {
    quote: Math.ceil(rates.quote * BURST_MULTIPLIER),
    depth: Math.ceil(rates.depth * BURST_MULTIPLIER),
    market_trade: Math.ceil(rates.market_trade * BURST_MULTIPLIER),
  };
  const events: ProviderEvidenceEvent[] = [];
  let index = 0;
  for (let second = 0; second < BURST_SECONDS; second += 1) {
    for (let tick = 0; tick < perSecond.quote; tick += 1) {
      index += 1;
      events.push(marketEvent("quote", CONTRACTS[tick % CONTRACTS.length] ?? CONTRACTS[0], index));
    }
    for (let tick = 0; tick < perSecond.depth; tick += 1) {
      index += 1;
      events.push(marketEvent("depth", CONTRACTS[tick % CONTRACTS.length] ?? CONTRACTS[0], index, {
        type: tick % 2,
        price: 20_000 + (tick % 10),
      }));
    }
    for (let tick = 0; tick < perSecond.market_trade; tick += 1) {
      index += 1;
      events.push(marketEvent("market_trade", CONTRACTS[0], index));
    }
    // One user-stream event per second stands in for the order/position/trade traffic that
    // must survive whatever the market stream does.
    index += 1;
    events.push(identityEvent("order", index));
  }
  return events;
}

describe("provider evidence write queue", () => {
  it("acknowledges the durable commit before provider evidence mutates state", async () => {
    const order: string[] = [];
    const writer = {
      appendBatch: (events: readonly ProviderEvidenceEvent[]) => {
        order.push(`persist:${events.length}`);
        return events.map((_event, offset) => ({ sequence: offset + 1 }));
      },
    };
    const queue = new EvidenceWriteQueue(writer);

    recordProviderEventBeforeApply({
      sink: queue,
      receivedUtc: "2026-08-20T15:30:00.000Z",
      source: "projectx_user_stream",
      eventType: "order",
      generation: 7,
      rawPayload: { id: 9001 },
      parse: () => ({ id: 9001, accountId: 101, contractId: CONTRACTS[0] }),
      identity: (value) => ({
        accountId: value.accountId,
        contractId: value.contractId,
        providerEntityId: String(value.id),
        providerTimestampUtc: null,
      }),
      apply: () => {
        order.push("apply");
      },
    });

    assert.deepEqual(order, [], "apply must wait for the durable commit");
    await queue.close();
    assert.deepEqual(order, ["persist:1", "apply"]);
    assert.equal(queue.metrics().resume_cursor, 1);
  });

  it("never drops identity evidence in a burst above the TS-R2-07 rates", async () => {
    const writer = new RecordingWriter();
    const queue = new EvidenceWriteQueue(writer, {
      highWaterMark: 500,
      coalesceWatermark: 100,
      lowWaterMark: 25,
    });
    const events = burstEvents();
    const identityCount = events.filter((event) => event.source === "projectx_user_stream").length;
    const applied: string[] = [];

    for (const event of events) {
      queue.submit(event, () => applied.push(`${event.eventType}:${event.providerEntityId}`));
    }
    await queue.close();

    const metrics = queue.metrics();
    assert.equal(metrics.depth, 0);
    assert.equal(metrics.dropped.identity, 0);
    assert.equal(metrics.coalesced.identity, 0);
    assert.equal(
      writer.written.filter((event) => event.source === "projectx_user_stream").length,
      identityCount,
    );
    assert.ok(metrics.high_water_hits > 0, "burst must reach the high-water mark");
    assert.ok(metrics.dropped.print > 0, "prints degrade first under overflow");
    assert.ok(metrics.coalesced.quote > 0, "quotes coalesce before anything is dropped");
    assert.equal(applied.length, writer.written.length, "only durable events are applied");
    assert.equal(
      applied.filter((entry) => entry.startsWith("order:")).length,
      identityCount,
    );
  });

  it("coalesces quotes and depth deterministically", async () => {
    const run = async (): Promise<string[]> => {
      const writer = new RecordingWriter();
      const queue = new EvidenceWriteQueue(writer, {
        highWaterMark: 500,
        coalesceWatermark: 100,
        lowWaterMark: 25,
      });
      for (const event of burstEvents()) {
        queue.submit(event, null);
      }
      await queue.close();
      return writer.written.map((event) => `${event.eventType}:${event.providerEntityId}`);
    };

    assert.deepEqual(await run(), await run());
  });

  it("keeps every event when the queue stays below the coalesce watermark", async () => {
    const writer = new RecordingWriter();
    const queue = new EvidenceWriteQueue(writer, { coalesceWatermark: 100, highWaterMark: 500, lowWaterMark: 25 });
    for (let index = 0; index < 20; index += 1) {
      queue.submit(marketEvent("quote", CONTRACTS[0], index), null);
    }
    await queue.close();

    assert.equal(writer.written.length, 20);
    assert.equal(queue.metrics().coalesced.quote, 0);
    assert.equal(queue.metrics().degraded, false);
  });

  it("keeps the newest quote per contract when coalescing engages", async () => {
    const writer = new RecordingWriter();
    const queue = new EvidenceWriteQueue(writer, { coalesceWatermark: 2, highWaterMark: 500, lowWaterMark: 1 });
    queue.submit(identityEvent("order", 1), null);
    queue.submit(identityEvent("order", 2), null);
    for (let index = 3; index <= 6; index += 1) {
      queue.submit(marketEvent("quote", CONTRACTS[0], index), null);
    }
    await queue.close();

    const quotes = writer.written.filter((event) => event.eventType === "quote");
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0]?.providerEntityId, `${CONTRACTS[0]}:6`);
    assert.equal(queue.metrics().coalesced.quote, 3);
  });

  it("clears the degraded flag only after the queue falls back to the low-water mark", async () => {
    const degraded: number[] = [];
    const recovered: number[] = [];
    const writer = new RecordingWriter();
    const queue = new EvidenceWriteQueue(writer, {
      highWaterMark: 500,
      coalesceWatermark: 100,
      lowWaterMark: 25,
      onDegraded: (metrics) => degraded.push(metrics.depth),
      onRecovered: (metrics) => recovered.push(metrics.depth),
    });

    for (const event of burstEvents()) {
      queue.submit(event, null);
    }
    assert.equal(degraded.length, 1, "overflow is edge-triggered, not one event per drop");
    assert.equal(recovered.length, 0);

    await queue.close();
    assert.equal(recovered.length, 1);
    assert.equal(queue.metrics().degraded, false);
  });

  it("retries a failed batch and applies nothing until it commits", async () => {
    const writer = new RecordingWriter();
    const errors: unknown[] = [];
    const applied: number[] = [];
    const queue = new EvidenceWriteQueue(writer, {
      onWriteError: (error) => errors.push(error),
    });
    writer.failuresRemaining = 1;
    queue.submit(identityEvent("position", 1), () => applied.push(1));

    await queue.drain();

    assert.equal(errors.length, 1);
    assert.deepEqual(applied, [1]);
    assert.equal(writer.written.length, 1);
    assert.equal(queue.metrics().write_failures, 1);
    assert.equal(queue.metrics().degraded, false, "a recovered write clears the degraded flag");
  });

  it("keeps the queue open and marks incomplete_shutdown when drain fails on close", async () => {
    const writer = new RecordingWriter();
    const queue = new EvidenceWriteQueue(writer);
    queue.submit(identityEvent("order", 1), null);
    await queue.drain();

    writer.failuresRemaining = Number.MAX_SAFE_INTEGER;
    queue.submit(identityEvent("order", 2), null);
    await assert.rejects(
      () => queue.close(),
      /evidence_queue_drain_failed:pending=1:resume_cursor=1/,
    );
    assert.equal(queue.metrics().closed, false);
    assert.equal(queue.metrics().incomplete_shutdown, true);
    assert.equal(queue.metrics().depth, 1);
    queue.submit(identityEvent("order", 3), null);
    writer.failuresRemaining = 0;
    await queue.close();
    assert.equal(queue.metrics().closed, true);
    assert.equal(queue.metrics().incomplete_shutdown, true);
  });

  it("reports the resumable cursor when the drain cannot complete", async () => {
    const writer = new RecordingWriter();
    const queue = new EvidenceWriteQueue(writer);
    queue.submit(identityEvent("order", 1), null);
    await queue.drain();

    writer.failuresRemaining = Number.MAX_SAFE_INTEGER;
    queue.submit(identityEvent("order", 2), null);
    await assert.rejects(
      () => queue.close(),
      /evidence_queue_drain_failed:pending=1:resume_cursor=1/,
    );
    assert.equal(queue.metrics().closed, false);
    assert.equal(queue.metrics().incomplete_shutdown, true);
    assert.doesNotThrow(() => queue.submit(identityEvent("order", 3), null));
  });
});
