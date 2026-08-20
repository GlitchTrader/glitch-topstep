import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Compiled under dist/tests/; scripts/ stays at repo root.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "build-paired-release-manifest.mjs");

test("paired release manifest requires evidence and marks human armed gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-release-"));
  const output = join(directory, "paired-release.json");
  try {
    execFileSync(
      process.execPath,
      [
        script,
        "--gateway-commit",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--profile-commit",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "--profile-version",
        "0.2.0",
        "--profile-manifest-sha256",
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "--prompt-version",
        "glitch-topstep-v9",
        "--evidence-ref",
        "docs/evidence/example-prac.md",
        "--output",
        output,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.schema_version, "glitch.topstep.paired_release.v1");
    assert.equal(manifest.immutable, true);
    assert.equal(manifest.armed_promotion_requires_human_approval, true);
    assert.equal(manifest.validation.prac_or_shadow_evidence_ref, "docs/evidence/example-prac.md");
    assert.equal(
      manifest.validation.partial_exit_provider_acceptance,
      "proven_prac_short_long_with_saga",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired release manifest fails closed without evidence-ref", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-release-missing-"));
  const output = join(directory, "paired-release.json");
  try {
    let message = "";
    try {
      execFileSync(
        process.execPath,
        [
          script,
          "--gateway-commit",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--profile-commit",
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "--profile-version",
          "0.2.0",
          "--profile-manifest-sha256",
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "--prompt-version",
          "glitch-topstep-v9",
          "--output",
          output,
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      message = error instanceof Error
        ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ""}`
        : String(error);
    }
    assert.match(message, /missing_evidence-ref/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
