/**
 * TS-R1-01: actual child-process kill matrix against a deterministic fake provider.
 * Proves durable intent/outbox survival and recovery without duplicate placeOrder calls.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { OrderInfo } from "../src/domain/models.js";
import { KILL_EXIT_CODE, KILL_POINTS, type KillPoint } from "../src/execution/kill-hook.js";
import { recoverExecutionMutations } from "../src/execution/recovery.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHILD = fileURLToPath(new URL("./kill-matrix-child.js", import.meta.url));
const INTENT_ID = "00000000-0000-4000-8000-000000000a01";
const EXIT_INTENT_ID = "00000000-0000-4000-8000-000000000a08";
const CUSTOM_TAG = `glt-${INTENT_ID}`.slice(0, 64);

interface CaseResult {
  point: KillPoint;
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  placeOrderCalls: number;
  mutationState: string | null;
  hasReceipt: boolean;
  intentCount: number;
  recoveryOutcome: string | null;
  blockingNewExposure: boolean;
}

function readCounter(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  return Number(readFileSync(path, "utf8") || "0");
}

function countIntents(store: SqliteExecutionStore): number {
  // ponytail: store has no public count; probe known fixture IDs
  let count = 0;
  if (store.registeredIntentPayload(INTENT_ID)) {
    count += 1;
  }
  if (store.registeredIntentPayload(EXIT_INTENT_ID)) {
    count += 1;
  }
  return count;
}

async function runKillPoint(point: KillPoint): Promise<CaseResult> {
  const directory = mkdtempSync(join(tmpdir(), `glitch-kill-${point}-`));
  const dbPath = join(directory, "glitch-topstep.sqlite");
  const dataDir = join(directory, "data");
  const counterPath = join(directory, "place-order-count.txt");
  const readyPath = join(directory, "ready.txt");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(counterPath, "0");

  const child = spawn(
    process.execPath,
    ["--enable-source-maps", CHILD],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        GLITCH_KILL_POINT: point,
        GLITCH_KILL_DB: dbPath,
        GLITCH_KILL_DATA_DIR: dataDir,
        GLITCH_KILL_COUNTER: counterPath,
        GLITCH_KILL_READY_FILE: readyPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  // Give WAL a moment to settle on Windows after forced kill.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const placeOrderCalls = readCounter(counterPath);
  const store = new SqliteExecutionStore(dbPath);
  try {
    const intentId = point === "during_close_position" ? EXIT_INTENT_ID : INTENT_ID;
    const mutation = store.mutationForIntent(intentId);
    const hasReceipt = store.receiptForIntent(intentId) !== null;
    const intentCount = countIntents(store);

    const historicalOrders: OrderInfo[] = placeOrderCalls > 0
      ? [{
          id: 9001,
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          creationTimestamp: "2026-07-21T12:00:10Z",
          updateTimestamp: "2026-07-21T12:00:11Z",
          status: 1,
          type: 2,
          side: 0,
          size: 1,
          limitPrice: null,
          stopPrice: null,
          customTag: CUSTOM_TAG,
        }]
      : [];

    // Past the 15s submitting grace window relative to the child's real submittingUtc.
    const recoveryNow = new Date(Date.now() + 60_000);
    const recovery = await recoverExecutionMutations(
      store,
      { searchOrders: async () => historicalOrders },
      101,
      "CON.F.US.MNQ.U26",
      point === "during_close_position"
        ? [{
            id: 1,
            accountId: 101,
            contractId: "CON.F.US.MNQ.U26",
            creationTimestamp: "2026-07-21T12:00:00Z",
            type: 1 as const,
            size: 1,
            averagePrice: 20_000,
          }]
        : [],
      recoveryNow,
    );

    for (const resolution of recovery.resolutions) {
      if (store.receiptForIntent(resolution.intentId)) {
        continue;
      }
      store.recordReceipt({
        schema_version: "glitch.direct.execution_receipt.v1",
        receipt_id: randomUUID(),
        recorded_utc: new Date().toISOString(),
        intent_id: resolution.intentId,
        mode: "armed",
        status: resolution.outcome === "ambiguous"
          ? "ambiguous"
          : resolution.outcome === "ignored"
            ? "ignored"
            : resolution.outcome === "confirmed_not_submitted" || resolution.outcome === "rejected"
              ? "rejected"
              : resolution.operation === "close_position"
                ? "closed"
                : "submitted",
        code: resolution.code,
        ...(resolution.providerOrderId === null ? {} : { order_id: resolution.providerOrderId }),
        detail: resolution.detail,
      });
    }

    const afterMutation = store.mutationForIntent(intentId);
    return {
      point,
      pid: child.pid,
      exitCode: code,
      signal,
      placeOrderCalls,
      mutationState: afterMutation?.state ?? mutation?.state ?? null,
      hasReceipt: store.receiptForIntent(intentId) !== null || hasReceipt,
      intentCount,
      recoveryOutcome: recovery.resolutions[0]?.outcome ?? null,
      blockingNewExposure: store.recoveryStatus().blockingNewExposure,
    };
  } finally {
    store.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ponytail: Windows can hold WAL locks briefly after forced child kill
    }
    void stderr;
  }
}

describe("TS-R1-01 process-kill matrix (fake provider)", () => {
  it("covers every kill point with one durable intent identity and no duplicate provider entry", async () => {
    assert.ok(existsSync(CHILD), `build child harness first: ${CHILD}`);

    const results: CaseResult[] = [];
    for (const point of KILL_POINTS) {
      results.push(await runKillPoint(point));
    }

    for (const result of results) {
      assert.equal(
        result.intentCount,
        1,
        `${result.point}: expected exactly one durable intent identity, got ${result.intentCount}`,
      );
      assert.ok(
        result.placeOrderCalls <= 1,
        `${result.point}: placeOrderCalls=${result.placeOrderCalls} must be 0 or 1`,
      );

      assert.equal(
        result.exitCode,
        KILL_EXIT_CODE,
        `${result.point}: expected kill exit ${KILL_EXIT_CODE}, got ${result.exitCode} signal=${result.signal}`,
      );
    }

    const byPoint = Object.fromEntries(results.map((result) => [result.point, result]));

    assert.equal(byPoint.after_intent_before_outbox?.placeOrderCalls, 0);
    assert.equal(byPoint.after_intent_before_outbox?.recoveryOutcome, "confirmed_not_submitted");
    assert.equal(byPoint.after_intent_before_outbox?.blockingNewExposure, false);

    assert.equal(byPoint.after_prepared_before_provider?.placeOrderCalls, 0);
    assert.equal(byPoint.after_prepared_before_provider?.mutationState, "confirmed_not_submitted");
    assert.equal(byPoint.after_prepared_before_provider?.recoveryOutcome, "confirmed_not_submitted");

    assert.equal(byPoint.after_submitting_before_transport?.placeOrderCalls, 0);
    assert.equal(byPoint.after_submitting_before_transport?.mutationState, "ambiguous");
    assert.equal(byPoint.after_submitting_before_transport?.blockingNewExposure, true);

    assert.equal(byPoint.during_transport_stall?.placeOrderCalls, 1);
    assert.ok(
      byPoint.during_transport_stall?.mutationState === "ambiguous"
        || byPoint.during_transport_stall?.mutationState === "submitted",
      `during_transport_stall state=${byPoint.during_transport_stall?.mutationState}`,
    );

    assert.equal(byPoint.after_accept_before_submitted?.placeOrderCalls, 1);
    assert.equal(byPoint.after_accept_before_submitted?.mutationState, "submitted");

    assert.equal(byPoint.after_submitted_before_receipt?.placeOrderCalls, 1);
    assert.equal(byPoint.after_submitted_before_receipt?.mutationState, "submitted");
    assert.equal(byPoint.after_submitted_before_receipt?.hasReceipt, true);

    assert.equal(byPoint.after_receipt_before_jsonl?.placeOrderCalls, 1);
    assert.equal(byPoint.after_receipt_before_jsonl?.hasReceipt, true);
    assert.equal(byPoint.after_receipt_before_jsonl?.mutationState, "submitted");

    assert.equal(byPoint.during_close_position?.placeOrderCalls, 0);
    assert.ok(
      byPoint.during_close_position?.mutationState === "ambiguous"
        || byPoint.during_close_position?.mutationState === "submitted",
      `during_close_position state=${byPoint.during_close_position?.mutationState}`,
    );

    assert.equal(byPoint.during_recovery?.placeOrderCalls, 0);
    assert.equal(byPoint.during_recovery?.exitCode, KILL_EXIT_CODE);
    assert.equal(byPoint.during_recovery?.intentCount, 1);

    assert.equal(byPoint.during_duplicate_wait?.placeOrderCalls, 1);
    assert.equal(byPoint.during_duplicate_wait?.intentCount, 1);
  });

  it("proves SQLite outbox identity survives process restart (TS-R1-02 process-level)", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-kill-restart-"));
    const dbPath = join(directory, "glitch-topstep.sqlite");
    try {
      const first = new SqliteExecutionStore(dbPath);
      first.registerIntent({
        schemaVersion: "glitch.intent.v2",
        intentId: INTENT_ID,
        createdUtc: "2026-07-21T12:00:04Z",
        instrument: "MNQ",
        account: "TEST_ACCOUNT",
        operatorProfile: "glitch-topstep",
        action: "ENTER_LONG",
        confidence: 0.6,
        snapshotHash: "restart-hash",
        modelVersion: "test",
        promptVersion: "glitch-topstep-v2",
        reason: "Restart persistence.",
        decisionAudit: {
          bullCase: "Bull.",
          bearCase: "Bear.",
          flatCase: "Flat.",
          aggressiveCase: "Aggressive.",
          conservativeCase: "Conservative.",
          decisiveEvidence: "Evidence.",
          disconfirmingEvidence: "Counter.",
          changeCondition: "Change.",
          finalChoice: "ENTER_LONG",
        },
        quantity: 1,
        orderType: "MARKET",
        stopLoss: 19_990.25,
        takeProfit1: 20_020.25,
      }, "2026-07-21T12:00:05Z");
      first.prepareMutation(
        INTENT_ID,
        "place_order",
        {
          accountId: 101,
          contractId: "CON.F.US.MNQ.U26",
          type: 2,
          side: 0,
          size: 1,
          stopLossBracket: { ticks: 39, type: 4 },
          takeProfitBracket: { ticks: 81, type: 1 },
        },
        CUSTOM_TAG,
        "2026-07-21T12:00:06Z",
      );
      first.markMutationSubmitting(INTENT_ID, "2026-07-21T12:00:07Z");
      assert.equal(first.recoveryStatus().blockingNewExposure, true);
      first.close();

      const second = new SqliteExecutionStore(dbPath);
      const mutation = second.mutationForIntent(INTENT_ID);
      assert.equal(mutation?.state, "submitting");
      assert.equal(mutation?.customTag, CUSTOM_TAG);
      assert.equal(second.recoveryStatus().entrySubmissionPending, true);
      assert.equal(second.recoveryStatus().blockingNewExposure, true);
      second.close();
    } finally {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // ponytail: Windows can hold WAL locks briefly after close(); temp dir is disposable
      }
    }
  });
});
