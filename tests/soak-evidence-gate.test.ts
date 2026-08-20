import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "validate-soak-evidence.mjs");

test("TS-AUDIT-13 soak evidence gate rejects incomplete chaos matrix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soak-evidence-"));
  const evidence = join(directory, "soak.json");
  try {
    await writeFile(
      evidence,
      `${JSON.stringify({
        schema_version: "glitch.topstep.soak_evidence.v1",
        duration_hours: 8,
        chaos_scenarios: ["reconnect"],
        invariants_violated: [],
        paired_release_ref: "release/example.json",
      })}\n`,
    );
    let message = "";
    try {
      execFileSync(process.execPath, [script, "--evidence", evidence], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      message = error instanceof Error
        ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}`
        : String(error);
    }
    assert.match(message, /insufficient_soak_duration|missing_chaos_scenario/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TS-AUDIT-13 soak evidence gate accepts paired release evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soak-evidence-ok-"));
  const evidence = join(directory, "soak.json");
  try {
    await writeFile(
      evidence,
      `${JSON.stringify({
        schema_version: "glitch.topstep.soak_evidence.v1",
        duration_hours: 24,
        started_utc: "2026-08-19T00:00:00.000Z",
        ended_utc: "2026-08-20T00:00:00.000Z",
        chaos_scenarios: [
          "reconnect",
          "rate_limit_429",
          "auth_expiry",
          "disk_pressure",
          "partial_restart",
        ],
        invariants_violated: [],
        paired_release_ref: "release/paired-release-example.json",
      })}\n`,
    );
    const output = execFileSync(process.execPath, [script, "--evidence", evidence], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.match(output, /soak_evidence_ok/);
    const parsed = JSON.parse(await readFile(evidence, "utf8"));
    assert.equal(parsed.schema_version, "glitch.topstep.soak_evidence.v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
