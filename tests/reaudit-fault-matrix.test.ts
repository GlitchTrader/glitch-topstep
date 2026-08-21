/**
 * TS-REAUDIT-10 fault matrix registry — each row maps to an automated proof in CI.
 * Run `npm run reaudit:fault-matrix` for the gate script + proof artifact.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const REAUDIT_FAULT_MATRIX = [
  {
    id: "auth_single_flight",
    proof: "tests/projectx-auth-manager.test.ts",
    scenario: "100 concurrent ensureAuthenticated → one login",
  },
  {
    id: "auth_read_401_recovery",
    proof: "tests/projectx-auth-manager.test.ts",
    scenario: "Safe read relogin after forced expiry",
  },
  {
    id: "auth_exposure_gate",
    proof: "tests/reaudit-phase1.test.ts",
    scenario: "auth.degraded blocks new_exposure_technically_supported",
  },
  {
    id: "identity_outbox_stage",
    proof: "tests/reaudit-phase1.test.ts",
    scenario: "Identity staged to sqlite before queue apply",
  },
  {
    id: "lifecycle_critical_shutdown",
    proof: "tests/lifecycle-supervisor.test.ts",
    scenario: "Critical disposer failure surfaced; resource retained",
  },
  {
    id: "flatten_restart_terminality",
    proof: "tests/flatten-workflow.test.ts",
    scenario: "Restart paths for waiting_for_flat and ambiguous flatten",
  },
  {
    id: "execution_kill_matrix",
    proof: "tests/kill-matrix.test.ts",
    scenario: "Child-process kill points for entry/exit recovery",
  },
  {
    id: "paired_release_digest",
    proof: "tests/paired-release-manifest.test.ts",
    scenario: "pair_digest + evidence-ref required in manifest",
  },
] as const;

describe("TS-REAUDIT-10 fault matrix registry", () => {
  for (const row of REAUDIT_FAULT_MATRIX) {
    it(`${row.id} declares proof file ${row.proof}`, () => {
      const path = join(ROOT, row.proof);
      assert.ok(existsSync(path), `missing proof file for ${row.id}: ${row.proof}`);
    });
  }
});
