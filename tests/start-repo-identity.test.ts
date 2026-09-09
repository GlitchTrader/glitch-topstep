import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(path.join(ROOT, "start.ps1"), "utf8");

test("start.ps1 refuses nested .wt-* worktree paths", () => {
  assert.match(script, /Assert-GatewayRepoIdentity/);
  assert.match(script, /\.wt-/);
  assert.match(script, /canonical glitch-topstep checkout/);
});

test("start.ps1 requires package name glitch-topstep and paired-contract", () => {
  assert.match(script, /package\.json/);
  assert.match(script, /paired-contract\.json/);
  assert.match(script, /glitch-topstep/);
  assert.match(script, /GlitchTrader\/glitch-topstep/);
});
