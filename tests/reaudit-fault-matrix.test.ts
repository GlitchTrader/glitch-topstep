/**
 * TS-REAUDIT-10 fault matrix registry — each row maps to an automated proof in CI.
 * Run `npm run reaudit:fault-matrix` for the gate script + proof artifact.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROOF_CONFIG = JSON.parse(
  readFileSync(join(ROOT, "scripts/reaudit-fault-matrix-proofs.json"), "utf8"),
) as { gateway: string[]; profile?: { proofs: string[]; unittest_module: string } };
const GATE_PROOF_FILES = PROOF_CONFIG.gateway;

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
  {
    id: "projectx_response_limit",
    proof: "tests/projectx-client.test.ts",
    scenario: "Oversized ProjectX response rejected before full buffering",
  },
  {
    id: "gateway_shutdown_deadline",
    proof: "tests/gateway-shutdown-deadline.test.ts",
    scenario: "HTTP shutdown completes within deadline with stuck connections",
  },
  {
    id: "audit_wave_abc_observability",
    proof: "tests/audit-wave-abc.test.ts",
    scenario: "Log sanitization, retry policy, and actionable health alerts",
  },
  {
    id: "audit_2026_08_25_mutation_no_retry",
    proof: "tests/projectx-client.test.ts",
    scenario: "Mutation placeOrder does not retry HTTP 429",
  },
  {
    id: "audit_2026_08_25_evidence_physical_bound",
    proof: "tests/invariant-metrics.test.ts",
    scenario: "Evidence queue exposes physical_depth for bounded memory observability",
  },
  {
    id: "audit_2026_08_25_packet_retention",
    proof: "tests/sqlite-execution-store.test.ts",
    scenario: "Expired issued_packets pruned while recovery refs preserved",
  },
  {
    id: "rollback_rehearsal_manifest",
    proof: "scripts/rollback-rehearsal.mjs",
    scenario: "Paired manifest and operations runbook present for rollback rehearsal",
  },
  {
    id: "profile_fault_injection",
    proof: "tests/test_fault_injection.py",
    scenario: "Profile export crash, lock steal, and delivery ambiguous recovery",
    repo: "profile",
  },
  {
    id: "audit_2026_08_25_bootstrap_export",
    proof: "tests/test_fault_injection.py",
    scenario: "bootstrap_decisions drains jsonl_export_queue after crash",
    repo: "profile",
  },
  {
    id: "audit_2026_08_25_preemption_tree_kill",
    proof: "tests/test_fault_injection.py",
    scenario: "Preemption uses terminate_pid_tree (taskkill /T on Windows)",
    repo: "profile",
  },
] as const;

describe("TS-REAUDIT-10 fault matrix registry", () => {
  it("gate proof list covers every registry proof file", () => {
    const registryProofs = [...new Set(REAUDIT_FAULT_MATRIX.map((row) => row.proof))];
    for (const proof of registryProofs) {
      if (proof === "tests/test_fault_injection.py") {
        assert.ok(
          PROOF_CONFIG.profile?.proofs.includes(proof),
          `gate missing registry proof: ${proof}`,
        );
        continue;
      }
      assert.ok(
        GATE_PROOF_FILES.includes(proof),
        `gate missing registry proof: ${proof}`,
      );
    }
  });

  it("proof config declares profile fault-injection module", () => {
    assert.equal(PROOF_CONFIG.profile?.unittest_module, "tests.test_fault_injection");
    assert.deepEqual(PROOF_CONFIG.profile?.proofs, ["tests/test_fault_injection.py"]);
  });

  for (const row of REAUDIT_FAULT_MATRIX) {
    it(`${row.id} declares proof file ${row.proof}`, () => {
      if ("repo" in row && row.repo === "profile") {
        assert.equal(row.proof, "tests/test_fault_injection.py");
        return;
      }
      const path = join(ROOT, row.proof);
      assert.ok(existsSync(path), `missing proof file for ${row.id}: ${row.proof}`);
    });
  }
});
