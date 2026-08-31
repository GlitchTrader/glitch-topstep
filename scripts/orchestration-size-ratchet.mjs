#!/usr/bin/env node
/**
 * TS-REAUDIT-07: fail when a tracked orchestration file grows past its recorded baseline, and
 * fail when src/ has an import cycle. Growth isn't forbidden -- bump the number in
 * scripts/orchestration-size-baseline.json in the same commit to make the decision visible in
 * review, rather than letting these files grow silently forever.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const errors = [];

// -- Size ratchet --------------------------------------------------------

const baselinePath = join(ROOT, "scripts/orchestration-size-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

function countLines(text) {
  // Match `wc -l` semantics: count newlines, not split() segments (a trailing newline must not
  // add a phantom extra line).
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

for (const [relPath, maxLines] of Object.entries(baseline)) {
  if (relPath.startsWith("_")) continue;
  const absPath = join(ROOT, relPath);
  const lineCount = countLines(readFileSync(absPath, "utf8"));
  if (lineCount > maxLines) {
    errors.push(
      `orchestration_size_ratchet: ${relPath} grew to ${lineCount} lines, `
      + `exceeds baseline ${maxLines}. Extract logic elsewhere, or if growth is deliberate for `
      + `this change, bump the number in scripts/orchestration-size-baseline.json in this same commit.`,
    );
  }
}

// -- Import-cycle check (first-party src/ only) --------------------------

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Pre-existing cycles found when this check was introduced (2026-08-31 audit) -- not
// re-litigated here (fixing them safely means restructuring imports in execution-critical
// files, which deserves its own reviewed change, not a side effect of adding this gate).
// New cycles outside this allowlist fail the gate. Remove an entry once it's actually fixed.
const KNOWN_CYCLES = new Set([
  "src/domain/order-ownership.ts|src/ownership/tranches.ts",
  "src/projectx/client.ts|src/projectx/read-circuit-breaker.ts",
  "src/projectx/client.ts|src/projectx/read-circuit-breaker.ts|src/projectx/retry-policy.ts",
  "src/execution/recovery-flatten.ts|src/execution/recovery.ts",
]);

const srcDir = join(ROOT, "src");
const files = listTsFiles(srcDir);
const importPattern = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) {
    return null; // external package, not part of the first-party cycle graph
  }
  const withoutExt = spec.replace(/\.js$/, "");
  const candidate = resolve(dirname(fromFile), `${withoutExt}.ts`);
  try {
    if (statSync(candidate).isFile()) {
      return candidate;
    }
  } catch {
    // fall through to index resolution
  }
  try {
    const indexCandidate = resolve(dirname(fromFile), withoutExt, "index.ts");
    if (statSync(indexCandidate).isFile()) {
      return indexCandidate;
    }
  } catch {
    return null;
  }
  return null;
}

const graph = new Map();
for (const file of files) {
  const content = readFileSync(file, "utf8");
  const targets = new Set();
  for (const match of content.matchAll(importPattern)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) {
      targets.add(resolved);
    }
  }
  graph.set(file, targets);
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map(files.map((f) => [f, WHITE]));
const stack = [];
const cycles = [];

function visit(node) {
  color.set(node, GRAY);
  stack.push(node);
  for (const next of graph.get(node) ?? []) {
    if (color.get(next) === GRAY) {
      const cycleStart = stack.indexOf(next);
      cycles.push([...stack.slice(cycleStart), next]);
    } else if (color.get(next) === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const file of files) {
  if (color.get(file) === WHITE) {
    visit(file);
  }
}

function toPosixRelative(f) {
  return relative(ROOT, f).split("\\").join("/");
}

if (cycles.length > 0) {
  const seen = new Set();
  for (const cycle of cycles) {
    const relPaths = cycle.map(toPosixRelative);
    const key = [...new Set(relPaths)].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    if (KNOWN_CYCLES.has(key)) continue;
    errors.push(`import_cycle (new, not in KNOWN_CYCLES allowlist): ${relPaths.join(" -> ")}`);
  }
}

if (errors.length > 0) {
  console.error(`orchestration-size-ratchet failed:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`orchestration-size-ratchet OK (${files.length} src files, no cycles, sizes within baseline)`);
