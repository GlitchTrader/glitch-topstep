import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKFLOW_MODULES = [
  "src/service/flatten-workflow.ts",
  "src/service/auth-session-workflow.ts",
  "src/service/reconciliation-service.ts",
  "src/service/lifecycle-supervisor.ts",
  "src/execution/protection-supervisor.ts",
  "src/projectx/auth-manager.ts",
] as const;

test("TS-AUDIT-09 workflow decomposition modules exist", () => {
  for (const relative of WORKFLOW_MODULES) {
    assert.ok(existsSync(path.join(ROOT, relative)), `missing ${relative}`);
  }
});
