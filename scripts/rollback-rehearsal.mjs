#!/usr/bin/env node
/** Rollback rehearsal gate — verifies paired manifest artifacts exist (audit C5). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifest = join(ROOT, "release", "paired-contract.json");
const runbook = join(ROOT, "docs", "OPERATIONS.md");

assert.ok(existsSync(manifest), `missing paired manifest: ${manifest}`);
assert.ok(existsSync(runbook), `missing operations runbook: ${runbook}`);
console.log("rollback_rehearsal_ok", { manifest, runbook });
