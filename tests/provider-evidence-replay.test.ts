import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  AccountInfo,
  ContractInfo,
  OrderInfo,
  PositionInfo,
  QuoteInfo,
  TradeInfo,
} from "../src/domain/models.js";
import type { StoredProviderEvidenceEvent } from "../src/domain/provider-evidence.js";
import {
  ProjectXEvidenceReplayService,
  replayProviderEvidence,
} from "../src/replay/projectx-evidence-replay.js";
import { SqliteProviderEvidenceStore } from "../src/storage/sqlite-provider-evidence-store.js";

const ACCOUNT: AccountInfo = {
  id: 101,
  name: "TEST_ACCOUNT",
  balance: 50_000,
  canTrade: true,
  isVisible: true,
  simulated: true,
};

const CONTRACT: ContractInfo = {
  id: "CON.F.US.MNQ.U26",
  name: "MNQU26",
  description: "Micro E-mini Nasdaq-100",
  tickSize: 0.25,
  tickValue: 0.5,
  activeContract: true,
  symbolId: "F.US.MNQ",
};

const POSITION: PositionInfo = {
  id: 201,
  accountId: ACCOUNT.id,
  contractId: CONTRACT.id,
  creationTimestamp: "2026-07-21T10:00:00Z",
  type: 1,
  size: 1,
  averagePrice: 20_000,
};

const OPEN_ORDER: OrderInfo = {
  id: 301,
  accountId: ACCOUNT.id,
  contractId: CONTRACT.id,
  creationTimestamp: "2026-07-21T10:01:00Z",
  updateTimestamp: "2026-07-21T10:01:00Z",
  status: 1,
  type: 2,
  side: 0,
  size: 1,
  limitPrice: null,
  stopPrice: null,
  customTag: "glt-replay",
};

const CLOSED_ORDER: OrderInfo = {
  ...OPEN_ORDER,
  updateTimestamp: "2026-07-21T10:02:00Z",
  status: 2,
};

const TRADE: TradeInfo = {
  id: 401,
  accountId: ACCOUNT.id,
  contractId: CONTRACT.id,
  creationTimestamp: "2026-07-21T10:02:00Z",
  price: 20_001,
  profitAndLoss: null,
  fees: 1.25,
  side: 0,
  size: 1,
  voided: false,
  orderId: OPEN_ORDER.id,
};

const QUOTE: QuoteInfo = {
  contractId: CONTRACT.id,
  symbol: "MNQ",
  symbolName: "Micro E-mini Nasdaq-100",
  lastPrice: 20_001,
  bestBid: 20_000.75,
  bestAsk: 20_001.25,
  open: 19_950,
  high: 20_050,
  low: 19_900,
  volume: 10_000,
  timestamp: "2026-07-21T10:02:00Z",
};

function evidence(
  sequence: number,
  eventType: string,
  normalizedPayload: unknown,
  source: StoredProviderEvidenceEvent["source"] = "projectx_rest",
): StoredProviderEvidenceEvent {
  return {
    sequence,
    receivedUtc: `2026-07-21T10:00:${String(sequence).padStart(2, "0")}Z`,
    providerTimestampUtc: null,
    source,
    eventType,
    generation: 1,
    accountId: ACCOUNT.id,
    contractId: CONTRACT.id,
    providerEntityId: null,
    relatedProviderEntityId: null,
    payloadHash: `hash-${sequence}`,
    rawPayload: null,
    normalizedPayload,
  };
}

describe("ProjectX evidence replay", () => {
  it("produces the same canonical state and hash from the same corpus", () => {
    const corpus = [
      evidence(1, "accounts_snapshot", [ACCOUNT]),
      evidence(2, "contracts_snapshot", [CONTRACT]),
      evidence(3, "positions_snapshot", [POSITION]),
      evidence(4, "open_orders_snapshot", [OPEN_ORDER]),
      evidence(5, "quote", QUOTE, "projectx_market_stream"),
      evidence(6, "historical_order", CLOSED_ORDER),
      evidence(7, "position", { ...POSITION, type: 0, size: 0 }, "projectx_user_stream"),
      evidence(8, "historical_trade", TRADE),
    ];

    const ordered = replayProviderEvidence(corpus);
    const reversed = replayProviderEvidence([...corpus].reverse());

    assert.equal(ordered.state_hash, reversed.state_hash);
    assert.equal(ordered.evidence_hash, reversed.evidence_hash);
    assert.equal(ordered.accounts.length, 1);
    assert.equal(ordered.contracts.length, 1);
    assert.equal(ordered.positions.length, 0);
    assert.equal(ordered.open_orders.length, 0);
    assert.equal(ordered.order_history[0]?.status, 2);
    assert.equal(ordered.trades[0]?.orderId, OPEN_ORDER.id);
    assert.equal(ordered.quotes[0]?.bestAsk, QUOTE.bestAsk);
    assert.equal(ordered.evidence_complete, true);
    assert.ok(reversed.issues.includes("input_not_strictly_sequence_ordered"));
  });

  it("reports sequence gaps, unsupported events, and invalid normalized payloads", () => {
    const result = replayProviderEvidence([
      evidence(2, "accounts_snapshot", [ACCOUNT]),
      evidence(4, "unrecognized", { anything: true }),
      evidence(5, "quote", { contractId: CONTRACT.id }, "projectx_market_stream"),
    ]);

    assert.equal(result.evidence_complete, false);
    assert.deepEqual(result.sequence_gaps, [
      { after_sequence: 0, before_sequence: 2, missing_count: 1 },
      { after_sequence: 2, before_sequence: 4, missing_count: 1 },
    ]);
    assert.equal(result.events_ignored, 1);
    assert.equal(result.events_invalid, 1);
    assert.ok(result.issues.includes("unsupported_event_type:4:unrecognized"));
    assert.ok(result.issues.includes("normalized_payload_invalid:5:quote"));
  });

  it("replays SQLite evidence in bounded batches and reports truncation", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-replay-"));
    const path = join(directory, "projectx-evidence.sqlite");
    const store = new SqliteProviderEvidenceStore(path);
    try {
      for (const event of [
        evidence(1, "accounts_snapshot", [ACCOUNT]),
        evidence(2, "contracts_snapshot", [CONTRACT]),
        evidence(3, "open_orders_snapshot", [OPEN_ORDER]),
      ]) {
        store.append({
          receivedUtc: event.receivedUtc,
          providerTimestampUtc: event.providerTimestampUtc,
          source: event.source,
          eventType: event.eventType,
          generation: event.generation,
          accountId: event.accountId,
          contractId: event.contractId,
          providerEntityId: event.providerEntityId,
          relatedProviderEntityId: event.relatedProviderEntityId,
          rawPayload: event.rawPayload,
          normalizedPayload: event.normalizedPayload,
        });
      }
      store.close();

      const replay = new ProjectXEvidenceReplayService(path);
      try {
        const truncated = replay.replay({ maxEvents: 2, batchSize: 1 });
        assert.equal(truncated.truncated, true);
        assert.equal(truncated.events_read, 2);
        assert.equal(truncated.through_sequence, 2);
        assert.equal(truncated.open_orders.length, 0);

        const throughTwo = replay.replay({ throughSequence: 2, batchSize: 1 });
        assert.equal(throughTwo.truncated, false);
        assert.equal(throughTwo.through_sequence, 2);
        assert.equal(throughTwo.contracts.length, 1);

        const complete = replay.replay({ batchSize: 2 });
        assert.equal(complete.truncated, false);
        assert.equal(complete.open_orders[0]?.id, OPEN_ORDER.id);
      } finally {
        replay.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
