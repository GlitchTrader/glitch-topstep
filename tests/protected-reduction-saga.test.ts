import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import {
  transitionProtectedReduction,
} from "../src/execution/protected-reduction-saga.js";
import { KILL_EXIT_CODE, KILL_POINTS } from "../src/execution/kill-hook.js";
import { SqliteExecutionStore } from "../src/storage/sqlite-execution-store.js";

describe("ProtectedReductionSaga state machine", () => {
  it("allows the durable reduction path and rejects illegal jumps", () => {
    transitionProtectedReduction(null, "reduction_prepared", "r1", "begin");
    transitionProtectedReduction("reduction_prepared", "reduction_submitting", "r1", "wire");
    transitionProtectedReduction("reduction_submitting", "reduction_ambiguous", "r1", "acked");
    transitionProtectedReduction("reduction_ambiguous", "degraded_stop_only", "r1", "stop");
    transitionProtectedReduction("degraded_stop_only", "reduced_protected", "r1", "tp");
    transitionProtectedReduction("reduced_protected", "flat", "r1", "flat");
    assert.throws(
      () => transitionProtectedReduction("flat", "reduction_prepared", "r1", "bad"),
      /invalid_state_transition/,
    );
  });

  it("persists reduction rows across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "glitch-reduction-"));
    const path = join(directory, "store.sqlite");
    const store = new SqliteExecutionStore(path);
    try {
      store.beginProtectedReduction({
        reductionId: "11111111-1111-4111-8111-111111111111",
        exitIntentId: "22222222-2222-4222-8222-222222222222",
        targetIntentId: "33333333-3333-4333-8333-333333333333",
        accountId: 101,
        contractId: "CON.F.US.MNQ.U26",
        exitQuantity: 1,
        positionSizeBefore: 2,
        survivorStopOrderId: 1001,
        survivorTargetOrderId: 1002,
        nowUtc: "2026-08-20T01:00:00.000Z",
      });
      store.advanceProtectedReduction(
        "22222222-2222-4222-8222-222222222222",
        "reduction_submitting",
        "test",
        "2026-08-20T01:00:01.000Z",
      );
      store.close();
      const reopened = new SqliteExecutionStore(path);
      const row = reopened.protectedReductionByExitIntent("22222222-2222-4222-8222-222222222222");
      assert.equal(row?.state, "reduction_submitting");
      assert.equal(row?.survivor_stop_order_id, 1001);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("ProtectedReductionSaga kill points", () => {
  for (const point of [
    "reduction_after_prepared",
    "reduction_after_cancel_before_place",
    "reduction_after_place_before_mark",
    "rearm_after_stop_before_tp",
  ] as const) {
    it(`registers kill point ${point}`, () => {
      assert.ok((KILL_POINTS as readonly string[]).includes(point));
    });
  }

  it("exits 73 when GLITCH_KILL_POINT matches reduction_after_prepared", () => {
    const script = `
      import { maybeKill } from "./dist/src/execution/kill-hook.js";
      maybeKill("reduction_after_prepared");
      console.log("survived");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, GLITCH_KILL_POINT: "reduction_after_prepared" },
      encoding: "utf8",
    });
    assert.equal(result.status, KILL_EXIT_CODE);
    assert.match(result.stderr, /GLITCH_KILL:reduction_after_prepared/);
  });
});
