import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { join } from "node:path";

// dist/tests -> repo root (two levels up from compiled output)
const ROOT = join(import.meta.dirname, "..", "..");

describe("validate-agent-paths", () => {
  it("passes on the current repository tree", () => {
    const output = execFileSync("node", ["scripts/validate-agent-paths.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.match(output, /validate-agent-paths OK/);
  });

  it("detects orphan gitlinks without .gitmodules url", () => {
    const tree = execFileSync("git", ["ls-tree", "-r", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const gitlinks = tree
      .split("\n")
      .filter((line) => line.startsWith("160000"))
      .map((line) => line.split("\t")[1])
      .filter(Boolean);
    assert.equal(gitlinks.length, 0, `orphan gitlinks remain: ${gitlinks.join(", ")}`);
  });
});
