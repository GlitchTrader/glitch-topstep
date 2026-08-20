import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const DOMAIN_DIR = join(ROOT, "src", "domain");
const EXECUTION_DIR = join(ROOT, "src", "execution");

const FORBIDDEN_DOMAIN_PATTERNS = [
  /from\s+["']node:fs/,
  /from\s+["']better-sqlite3/,
  /from\s+["'][^"']*projectx\//,
  /from\s+["'][^"']*\/storage\//,
];

const FORBIDDEN_EXECUTION_SERVICE = /from\s+["'][^"']*\/service\//;

function listTsFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

test("domain modules avoid filesystem, sqlite, and projectx adapter imports", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(DOMAIN_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_DOMAIN_PATTERNS) {
      if (pattern.test(source)) {
        violations.push(`${file.replace(`${ROOT}\\`, "")}: ${pattern}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("execution modules do not import service layer", () => {
  const violations: string[] = [];
  for (const file of listTsFiles(EXECUTION_DIR)) {
    const source = readFileSync(file, "utf8");
    if (FORBIDDEN_EXECUTION_SERVICE.test(source)) {
      violations.push(file.replace(`${ROOT}\\`, ""));
    }
  }
  assert.deepEqual(violations, []);
});

test("state machine contract module exists in domain layer", () => {
  const domainState = statSync(join(DOMAIN_DIR, "state-machines.ts"));
  assert.ok(domainState.isFile());
});
