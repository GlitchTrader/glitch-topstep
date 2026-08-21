import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** TS-AUDIT-11: each production audit row must map to an executable regression file. */
const AUDIT_REGRESSION_FILES = [
  "tests/rearm-latch-regression.test.ts",
  "tests/projectx-auth-manager.test.ts",
  "tests/flatten-saga.test.ts",
  "tests/evidence-write-queue.test.ts",
  "tests/market-alignment.test.ts",
  "tests/safety-supervisor.test.ts",
  "tests/invariant-metrics.test.ts",
  "tests/soak-evidence-gate.test.ts",
  "tests/data-phase-d-gate.test.ts",
  "tests/flatten-workflow.test.ts",
  "tests/protection-supervisor.test.ts",
  "tests/workflow-decomposition.test.ts",
  "tests/intent-delivery-status.test.ts",
] as const;

test("TS-AUDIT-11 regression matrix files exist", () => {
  for (const relative of AUDIT_REGRESSION_FILES) {
    assert.ok(existsSync(path.join(ROOT, relative)), `missing ${relative}`);
  }
});
