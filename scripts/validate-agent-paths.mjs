#!/usr/bin/env node
/** Fail CI when AGENTS.md or .codex/skills reference missing paths. */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const errors = [];

function validateGitlinksHaveSubmoduleUrls() {
  const tree = execFileSync("git", ["ls-tree", "-r", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const gitlinks = tree
    .split("\n")
    .filter((line) => line.startsWith("160000"))
    .map((line) => line.split("\t")[1])
    .filter(Boolean);
  if (!gitlinks.length) {
    return;
  }
  const modulesPath = join(root, ".gitmodules");
  const urlByPath = new Map();
  if (existsSync(modulesPath)) {
    const content = readFileSync(modulesPath, "utf8");
    for (const match of content.matchAll(/\[submodule "([^"]+)"\][\s\S]*?url\s*=\s*(.+)/g)) {
      urlByPath.set(match[1], match[2].trim());
    }
  }
  for (const path of gitlinks) {
    const url = urlByPath.get(path);
    if (!url) {
      errors.push(`orphan gitlink (missing .gitmodules url): ${path}`);
    }
  }
}

function checkPath(relative) {
  const path = join(root, relative.replace(/\//g, "\\"));
  const unix = join(root, relative);
  if (!existsSync(path) && !existsSync(unix)) {
    errors.push(`missing: ${relative}`);
  }
}

const required = [
  "docs/plans/2026-08-20-nt-adaptation-roadmap.md",
  "docs/ledger/ledger.json",
  "release/paired-contract.json",
  "src/domain/state-machines.ts",
  "AGENTS.md",
  ".codex/skills/topstep-route-work/SKILL.md",
  ".codex/skills/topstep-hermes-pairing/SKILL.md",
  ".codex/skills/topstep-projectx-contracts/SKILL.md",
  ".codex/skills/topstep-execution-safety/SKILL.md",
  ".codex/skills/topstep-live-acceptance/SKILL.md",
  ".codex/skills/topstep-doc-ledger/SKILL.md",
  ".codex/skills/topstep-release-pair/SKILL.md",
];

for (const path of required) {
  checkPath(path);
}

validateGitlinksHaveSubmoduleUrls();

const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
for (const match of agents.matchAll(/`([^`]+\.(?:ts|md|json|ps1))`/g)) {
  const candidate = match[1];
  if (candidate.includes("*") || candidate.startsWith("http")) continue;
  checkPath(candidate);
}

if (errors.length) {
  console.error("validate-agent-paths failed:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("validate-agent-paths OK");
